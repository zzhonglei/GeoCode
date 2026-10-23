export * as Quota from "./quota.ts"

import { Effect, Exit, Schema } from "effect"
import { Bundled } from "../bundled.ts"
import { Engine } from "../engine.ts"
import type { Runtime } from "../runtime.ts"
import { Python } from "./python.ts"

const Snapshot = Schema.Struct({
  project: Schema.String,
  limitSeconds: Schema.NullOr(Schema.Number),
  usedSeconds: Schema.NullOr(Schema.Number),
  sampledAt: Schema.NullOr(Schema.String),
  resetsAt: Schema.String,
})

export type Snapshot = typeof Snapshot.Type

const Report = Schema.Union([
  Schema.Struct({ quota: Snapshot }),
  Schema.Struct({ error: Schema.String, status: Schema.optionalKey(Schema.Number) }),
])
const decodeReport = Schema.decodeUnknownExit(Report)

export const query = (runtime: Runtime.Interface, python: string, project: string, signal: AbortSignal) =>
  Effect.gen(function* () {
    const result = yield* runtime
      .run({
        ...Bundled.python(python, ["-"]),
        input: Python.program(PROGRAM, { project }),
        delivery: { mode: "collect" },
        clocks: { total: "90 seconds" },
        signal,
      })
      .pipe(Effect.mapError((error) => new Engine.Failure({ code: "start-failed", message: error.message })))
    if (result.reason === "abort") {
      return yield* new Engine.Failure({ code: "cancelled", message: "the quota query was cancelled" })
    }
    if (result.reason === "timeout") {
      return yield* new Engine.Failure({ code: "timeout", message: "the quota query did not finish within 90 seconds" })
    }
    const decoded = decodeReport(Python.marked(result.stdout).at(-1))
    if (Exit.isFailure(decoded) || result.code !== 0) {
      return yield* new Engine.Failure({
        code: "quota-failed",
        message: "the Python ended without a quota report",
        details: { project, output: `${result.stdout}\n${result.stderr}`.slice(-16384) },
      })
    }
    if ("error" in decoded.value) {
      return yield* new Engine.Failure({
        code: "quota-failed",
        message: decoded.value.error,
        details: { project, status: decoded.value.status },
      })
    }
    return decoded.value.quota
  })

const PROGRAM = String.raw`
import datetime as dt
import json
import sys
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests
from google.auth.transport.requests import AuthorizedSession

${Python.CREDENTIALS}

request = json.loads(REQUEST)
project = request["project"]
metric = "earthengine.googleapis.com/monthly_eecu_usage_time"


def timestamp(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def pages(session, method, url, collection, params=None, body=None):
    while True:
        response = session.request(method, url, params=params, json=body, timeout=(10, 25))
        response.raise_for_status()
        data = response.json()
        if data.get("partialErrors"):
            raise RuntimeError("Incomplete quota usage: " + json.dumps(data["partialErrors"]))
        yield from data.get(collection, [])
        token = data.get("nextPageToken")
        if not token:
            return
        if method == "GET":
            params = dict(params or {}, pageToken=token)
        if method == "POST":
            body = dict(body or {}, pageToken=token)


def query():
    now = dt.datetime.now(dt.timezone.utc)
    local = now.astimezone(ZoneInfo("America/Los_Angeles"))
    start = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    reset = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    encoded = quote(project, safe="")
    with AuthorizedSession(credentials()) as session:
        session.headers["X-Goog-User-Project"] = project
        metrics = pages(
            session, "GET",
            "https://serviceusage.googleapis.com/v1beta1/projects/" + encoded
            + "/services/earthengine.googleapis.com/consumerQuotaMetrics",
            "metrics", params={"view": "FULL", "pageSize": 200},
        )
        monthly = next((item for item in metrics if item.get("metric") == metric), None)
        if monthly is None:
            raise RuntimeError("No monthly Earth Engine quota is available for this project")
        buckets = [
            bucket for limit in monthly.get("consumerQuotaLimits", []) if limit.get("unit") == "1/{project}"
            for bucket in limit.get("quotaBuckets", []) if not bucket.get("dimensions")
        ]
        if len(buckets) != 1:
            raise RuntimeError("No project-wide monthly Earth Engine quota limit was returned")
        limit = int(buckets[0]["effectiveLimit"])
        # Unlike list and PromQL, this MQL endpoint can query a project with no billing account.
        mql = (
            "fetch consumer_quota | metric 'serviceruntime.googleapis.com/quota/allocation/usage' "
            "| filter metric.quota_metric == '" + metric + "' "
            "&& resource.service == 'earthengine.googleapis.com' "
            "&& resource.project_id == " + json.dumps(project) + " | within 2d"
        )
        rows = pages(
            session, "POST", "https://monitoring.googleapis.com/v3/projects/" + encoded + "/timeSeries:query",
            "timeSeriesData", body={"query": mql},
        )
        latest = None
        for row in rows:
            for point in row.get("pointData", []):
                at = dt.datetime.fromisoformat(point["timeInterval"]["endTime"].replace("Z", "+00:00"))
                # The last two days can include the previous month's quota before its first new sample arrives.
                if at < start or (latest is not None and at <= latest[0]):
                    continue
                latest = (at, int(point["values"][0]["int64Value"]))
        return {
            "project": project,
            "limitSeconds": None if limit in (-1, 9223372036854775807) else limit,
            "usedSeconds": latest[1] if latest is not None else None,
            "sampledAt": timestamp(latest[0]) if latest is not None else None,
            "resetsAt": timestamp(reset),
        }


try:
    report = {"quota": query()}
except requests.exceptions.HTTPError as error:
    response = error.response
    report = {"error": response.json().get("error", {}).get("message", str(error)), "status": response.status_code}
except Exception as error:
    report = {"error": "%s: %s" % (type(error).__name__, error)}

sys.stdout.write("${Python.MARKER}" + json.dumps(report) + "\n")
sys.stdout.flush()
`
