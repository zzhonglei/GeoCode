import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { python3 } from "../../support/common.ts"
import { start } from "../../support/gee.ts"

const METRIC = "earthengine.googleapis.com/monthly_eecu_usage_time"

const point = (at: string, value: number) => ({
  timeInterval: { endTime: at },
  values: [{ int64Value: String(value) }],
})

const limit = (value = "540000") => ({
  metric: METRIC,
  consumerQuotaLimits: [{ unit: "1/{project}", quotaBuckets: [{ effectiveLimit: value }] }],
})

// The real Python reads paged replies instead of the network, and uses the fixture's clock at month boundaries.
const SESSION = `
import datetime
import json
import os
import flags
import requests.exceptions

with open(os.path.join(flags.FOLDER, "quota.json")) as source:
    fixture = json.load(source)

original_datetime = datetime.datetime


class Clock(original_datetime):
    @classmethod
    def now(cls, tz=None):
        return original_datetime.fromisoformat(fixture["now"]).astimezone(tz)


datetime.datetime = Clock


class HTTPError(Exception):
    def __init__(self, response):
        self.response = response


requests.exceptions.HTTPError = HTTPError


class Response:
    def __init__(self, reply):
        self.status_code = reply.get("status", 200)
        self.body = reply["body"]

    def raise_for_status(self):
        if self.status_code != 200:
            raise HTTPError(self)

    def json(self):
        # A reply with no body stands for a page, such as a proxy's, that is not JSON.
        if self.body is None:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self.body


class AuthorizedSession:
    def __init__(self, credentials):
        assert credentials.refresh_token == "token"
        self.headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def request(self, method, url, params=None, json=None, timeout=None):
        assert self.headers["X-Goog-User-Project"] == "majestic"
        assert "/projects/majestic/" in url
        if method == "GET":
            assert url.endswith("/consumerQuotaMetrics")
            replies = fixture["limits"]
            token = (params or {}).get("pageToken", "0")
        else:
            assert method == "POST" and url.endswith("/timeSeries:query")
            assert "monthly_eecu_usage_time" in json["query"]
            assert 'resource.project_id == "majestic"' in json["query"]
            if "window" in fixture:
                assert json["query"].endswith("| within " + fixture["window"]), json["query"]
            replies = fixture["usage"]
            token = json.get("pageToken", "0")
        reply = replies[int(token)]
        # A reply with "timeouts" stands for Google not answering in time that many times before it answers.
        if reply.get("timeouts", 0) > 0:
            reply["timeouts"] -= 1
            raise requests.exceptions.Timeout("Read timed out. (read timeout=10)")
        # And "busy", for Google answering that it is overloaded that many times before it answers.
        if reply.get("busy", 0) > 0:
            reply["busy"] -= 1
            return Response({"status": 503, "body": {"error": {"message": "The service is currently unavailable."}}})
        return Response(reply)
`

/** `window`, when given, is how far back the usage query must reach. */
const query = async (limits: unknown[], usage: unknown[], now = "2026-10-23T09:00:00+00:00", window?: string) => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    const fixture = JSON.stringify({ limits, usage, now, window })
    await fs.writeFile(path.join(engine.directory, "stubs/flags/quota.json"), fixture)
    await fs.appendFile(path.join(engine.directory, "stubs/google/auth/transport/requests.py"), SESSION)
    const response = await engine.response(engine.send({}, "gee.quota"))
    assert.equal(engine.states().at(-1)?.status, "ready")
    return response
  } finally {
    await engine.stop()
  }
}

test(
  "quota takes the actual limit and latest monthly sample across pages, not a sum or maximum value",
  { skip: !python3 },
  async () => {
    const response = await query(
      [{ body: { metrics: [], nextPageToken: "1" } }, { body: { metrics: [limit("3600000")] } }],
      [
        { body: { timeSeriesData: [{ pointData: [point("2026-10-23T08:28:00Z", 90582)] }], nextPageToken: "1" } },
        {
          body: {
            timeSeriesData: [
              { pointData: [point("2026-10-23T08:57:56Z", 90476), point("2026-10-22T08:00:00Z", 90000)] },
            ],
          },
        },
      ],
      // Guards against missing this month's usage written only early in the month, reaching back a fixed time alone.
      "2026-10-23T09:00:00+00:00",
      "23d",
    )
    assert.ok(response.ok, JSON.stringify(response))
    assert.deepEqual(response.result, {
      project: "majestic",
      limitSeconds: 3600000,
      usedSeconds: 90476,
      sampledAt: "2026-10-23T08:57:56Z",
      resetsAt: "2026-11-01T07:00:00Z",
    })
  },
)

test(
  "missing samples remain unknown, zero is a value, and unlimited is not an enormous finite quota",
  { skip: !python3 },
  async () => {
    for (const value of ["0", "-1", "9223372036854775807"]) {
      const response = await query([{ body: { metrics: [limit(value)] } }], [{ body: {} }])
      assert.ok(response.ok, JSON.stringify(response))
      assert.deepEqual(response.result, {
        project: "majestic",
        limitSeconds: value === "0" ? 0 : null,
        usedSeconds: null,
        sampledAt: null,
        resetsAt: "2026-11-01T07:00:00Z",
      })
    }
    const response = await query(
      [{ body: { metrics: [limit()] } }],
      [{ body: { timeSeriesData: [{ pointData: [point("2026-10-23T08:00:00Z", 0)] }] } }],
    )
    assert.ok(response.ok, JSON.stringify(response))
    assert.equal((response.result as { usedSeconds: number }).usedSeconds, 0)
  },
)

test(
  "a new Pacific month excludes old samples and resets across daylight saving and the year",
  { skip: !python3 },
  async () => {
    for (const [now, reset] of [
      ["2026-11-01T07:30:00+00:00", "2026-12-01T08:00:00Z"],
      ["2027-01-01T08:30:00+00:00", "2027-02-01T08:00:00Z"],
    ]) {
      const previous = new Date(Date.parse(now) - 3600000).toISOString()
      const response = await query(
        [{ body: { metrics: [limit()] } }],
        [{ body: { timeSeriesData: [{ pointData: [point(previous, 500000)] }] } }],
        now,
        "1d",
      )
      assert.ok(response.ok, JSON.stringify(response))
      assert.equal((response.result as { usedSeconds: null }).usedSeconds, null)
      assert.equal((response.result as { resetsAt: string }).resetsAt, reset)
    }
  },
)

test(
  "a refusal, partial query or absent quota fails without inventing zero usage or a default tier",
  { skip: !python3 },
  async () => {
    const refused = await query([{ status: 403, body: { error: { message: "Monitoring permission denied" } } }], [])
    assert.equal(!refused.ok && refused.error.code, "quota-failed")
    assert.equal(!refused.ok && refused.error.message, "Monitoring permission denied")
    // Guards against an answer that is not JSON, such as a proxy's error page, ending the query without its status.
    for (const body of [null, [], { error: "Bad gateway" }]) {
      const page = await query([{ status: 407, body }], [])
      assert.equal(!page.ok && page.error.code, "quota-failed")
      assert.equal(!page.ok && (page.error.details as { status?: number }).status, 407)
    }
    const partial = await query(
      [{ body: { metrics: [limit()] } }],
      [
        {
          body: {
            timeSeriesData: [{ pointData: [point("2026-10-23T08:00:00Z", 100)] }],
            partialErrors: [{ code: 13, message: "incomplete" }],
          },
        },
      ],
    )
    assert.equal(!partial.ok && partial.error.code, "quota-failed")
    const missing = await query([{ body: { metrics: [] } }], [])
    assert.equal(!missing.ok && missing.error.code, "quota-failed")
  },
)

test(
  "a request Google does not answer in time is tried once more, and a network failing twice is unreachable",
  { skip: !python3 },
  async () => {
    // Guards against one slow answer failing the query, as a network that stutters makes it.
    const late = await query(
      [{ timeouts: 1, body: { metrics: [limit()] } }],
      [{ body: { timeSeriesData: [{ pointData: [point("2026-10-23T08:00:00Z", 100)] }] } }],
    )
    assert.ok(late.ok, JSON.stringify(late))
    assert.equal((late.result as { usedSeconds: number }).usedSeconds, 100)
    // Guards against a network failing for good reading as Google refusing, which the interface words otherwise.
    const gone = await query([{ timeouts: 2, body: { metrics: [limit()] } }], [])
    assert.equal(!gone.ok && gone.error.code, "unreachable")
    assert.match((!gone.ok && gone.error.message) || "", /Timeout: Read timed out/)
  },
)

test(
  "Google busy is tried once more, and busy twice is unreachable with its status, not a refusal",
  { skip: !python3 },
  async () => {
    // Guards against one overloaded answer failing the query.
    const once = await query(
      [{ body: { metrics: [limit()] } }],
      [{ busy: 1, body: { timeSeriesData: [{ pointData: [point("2026-10-23T08:00:00Z", 100)] }] } }],
    )
    assert.ok(once.ok, JSON.stringify(once))
    // Guards against Google failing or overloaded reading as a refusal, which sends the user to the project's APIs.
    for (const status of [502, 429]) {
      const twice = await query([{ status, body: { error: { message: "Try again later" } } }], [])
      assert.equal(!twice.ok && twice.error.code, "unreachable")
      assert.equal(!twice.ok && (twice.error.details as { status?: number }).status, status)
    }
  },
)
