import assert from "node:assert/strict"
import { test } from "node:test"
import {
  answer,
  counts,
  fresh,
  instanceOf,
  isProbe,
  queriesOf,
  serve,
  start,
  told,
  waitedOn,
  type Asked,
} from "../../support/osm.ts"
import { python3 } from "../../support/common.ts"

const BOX = "bbox:24.93,121.36,24.96,121.39"

/** One statement's element in Overpass's answer to `out count`. */
const count = (total: number) => ({
  type: "count",
  id: 0,
  tags: { nodes: String(total), ways: "0", relations: "0", total: String(total) },
})

const overpass = (asked: readonly Asked[]) => asked.filter((request) => request.service === "overpass")
/** The instances asked a call's own queries, in order, and those probed. */
const queried = (asked: readonly Asked[]) => queriesOf(asked).map(instanceOf)
const probes = (asked: readonly Asked[]) => overpass(asked).filter((request) => isProbe(request.query))

/** The shortest time between two probes of the same instance, in milliseconds. */
const closest = (asked: readonly Asked[]) => {
  const times = new Map<number, number[]>()
  for (const request of probes(asked))
    times.set(instanceOf(request), [...(times.get(instanceOf(request)) ?? []), request.at])
  const gaps = [...times.values()].flatMap((list) => list.slice(1).map((at, index) => at - list[index]))
  return Math.min(...gaps)
}

test(
  "a query goes to an instance a probe found free, not to one busy or with old data",
  { skip: !python3 },
  async () => {
    const stale = { osm3s: { timestamp_osm_base: "2020-01-01T00:00:00Z" }, elements: [] }
    const services = await serve({
      overpass: (_query, index) =>
        index === 0 ? { status: 502, body: "at capacity" } : index === 1 ? { json: stale } : counts(4),
    })
    const engine = await start(python3!, services.services)
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(done.ok, JSON.stringify(done))
      assert.equal((done.result as { rows: { total: number }[] }).rows[0].total, 4)
      assert.deepEqual(probes(services.asked).map(instanceOf).sort(), [0, 1, 2])
      assert.deepEqual(queried(services.asked), [2])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "an instance that keeps a request waiting does not hold up a call another can answer",
  { skip: !python3 },
  async () => {
    const services = await serve({ overpass: (_query, index) => (index === 0 ? { silent: true } : counts(4)) })
    const engine = await start(python3!, services.services)
    try {
      const began = Date.now()
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(done.ok, JSON.stringify(done))
      // Guards against asking the instances in turn: the silent one would be waited out for the query's time limit.
      assert.ok(Date.now() - began < 5000, `took ${Date.now() - began} ms`)
      assert.ok(!queried(services.asked).includes(0), JSON.stringify(queried(services.asked)))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "instances that said they were busy are probed again only after the pause, then asked",
  { skip: !python3 },
  async () => {
    const probed = [0, 0, 0]
    const services = await serve({
      overpass: (query, index) => {
        if (!isProbe(query)) return counts(4)
        probed[index] += 1
        return index === 2 && probed[index] > 1 ? answer([]) : { status: 503, body: "busy" }
      },
    })
    const engine = await start(python3!, services.services, { pause: 1.5 })
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(done.ok, JSON.stringify(done))
      assert.deepEqual(queried(services.asked), [2])
      // Guards against asking a busy instance again sooner than the official one's policy allows.
      assert.ok(closest(services.asked) >= 1450, `probed again after ${closest(services.asked)} ms`)
      assert.ok(waitedOn(engine.sent).some((state) => state.busy))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "an instance that answers with something other than an Overpass answer is not asked again",
  { skip: !python3 },
  async () => {
    let probed = 0
    const services = await serve({
      overpass: (query, index) => {
        if (index === 0) return { status: 200, body: "<html>Welcome</html>" }
        if (index === 1) return { json: { status: "ok" } }
        if (!isProbe(query)) return counts(4)
        probed += 1
        return probed > 1 ? answer([]) : { status: 503, body: "busy" }
      },
    })
    const engine = await start(python3!, services.services, { pause: 0.5 })
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(done.ok, JSON.stringify(done))
      // Guards against a page that is not an answer being taken for a busy instance, and probed again after each pause,
      // or JSON without elements being taken for an answer, and failing the call where it is read.
      for (const index of [0, 1]) {
        assert.equal(probes(services.asked).filter((request) => instanceOf(request) === index).length, 1)
      }
      assert.deepEqual(queried(services.asked), [2])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "an instance waited for less than its query's time, as the call had less left, is paused rather than passed over",
  { skip: !python3 },
  async () => {
    let probed = 0
    let asked = 0
    const services = await serve({
      overpass: (query, index) => {
        if (index > 0) return { status: 404, body: "moved" }
        if (isProbe(query)) {
          probed += 1
          // The first probe goes unanswered, so the query that follows starts with less of the call left.
          return probed === 1 ? { silent: true } : answer([])
        }
        asked += 1
        // A piece, then silence longer than the call had left to wait when it asked.
        return asked === 1
          ? { trickle: { osm3s: { timestamp_osm_base: fresh() }, elements: [count(4)] }, pieces: 2, every: 10000 }
          : counts(4)
      },
    })
    const engine = await start(python3!, services.services, { stall: 6, pause: 1, probe: 2 })
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      // Guards against an instance cut short by the call's own deadline being passed over for the rest of the call,
      // and against a probe that timed out being taken for one that cannot be reached.
      assert.ok(done.ok, JSON.stringify(done))
      assert.deepEqual(queried(services.asked), [0, 0])
      assert.ok(probed >= 3, String(probed))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a probe that fails in a way of its own leaves its instance to be probed again, not waited on for good",
  { skip: !python3 },
  async () => {
    let probed = 0
    const services = await serve({
      overpass: (query, index) => {
        if (index > 0) return { status: 404, body: "moved" }
        if (!isProbe(query)) return counts(4)
        probed += 1
        // More than any answer but a download's may hold.
        return probed === 1 ? answer([], { padding: "x".repeat(17 * 1024 * 1024) }) : answer([])
      },
    })
    const engine = await start(python3!, services.services, { stall: 6, pause: 0.5 })
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      // Guards against a probe that fails in a way of its own, as with an answer too large to hold, being taken for an
      // instance that cannot be reached, or ending its thread and leaving the instance probed for good.
      assert.ok(done.ok, JSON.stringify(done))
      assert.deepEqual(queried(services.asked), [0])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a query Overpass refuses is answered with its own words, no other instance asked",
  { skip: !python3 },
  async () => {
    const page = '<p><strong style="color:#FF0000">Error</strong>: line 1: parse error: Invalid regular expression</p>'
    const services = await serve({ overpass: (query) => (isProbe(query) ? answer([]) : { status: 400, body: page }) })
    const engine = await start(python3!, services.services)
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["name~("] })
      assert.ok(!done.ok)
      assert.equal(done.error.code, "refused")
      assert.match(done.error.message, /Invalid regular expression/)
      assert.equal(queried(services.asked).length, 1)
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test("a word is looked at as each way OSM tags it, with how many features carry each", { skip: !python3 }, async () => {
  const services = await serve({
    overpass: (query) =>
      counts(
        ...query
          .split("out count")
          .slice(1)
          .map((_, at) => at + 1),
      ),
  })
  const engine = await start(python3!, services.services)
  try {
    const done = await engine.call("probe", { area: BOX, term: "hospital" })
    assert.ok(done.ok, JSON.stringify(done))
    const rows = (done.result as { rows: { filter: string; why: string; total: number }[] }).rows
    // Guards against counting only the preset's own tags: new hospitals get healthcare=hospital too.
    assert.deepEqual(
      rows.slice(0, 2).map((row) => [row.filter, row.why]),
      [
        ["amenity=hospital", "preset"],
        ["healthcare=hospital", "added"],
      ],
    )
    assert.deepEqual(
      rows.map((row) => row.total),
      rows.map((_, at) => at + 1),
    )
  } finally {
    await engine.stop()
    await services.close()
  }
})

test(
  "a call no instance answers stops once it has made no progress for as long as it may",
  { skip: !python3 },
  async () => {
    const services = await serve({ overpass: () => ({ silent: true }) })
    const engine = await start(python3!, services.services, { stall: 2 })
    try {
      const began = Date.now()
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(!done.ok)
      assert.equal(done.error.code, "stalled")
      assert.deepEqual(done.error.details, { seconds: 2 })
      // Guards against each silent instance being waited out for the probe's own time.
      assert.ok(Date.now() - began < 10000, `took ${Date.now() - began} ms`)
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "instances that keep saying they are busy are probed again after each pause, and their answers are no progress",
  { skip: !python3 },
  async () => {
    const services = await serve({ overpass: () => ({ status: 503, body: "busy" }) })
    const engine = await start(python3!, services.services, { stall: 4, pause: 1 })
    try {
      const began = Date.now()
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(!done.ok)
      assert.equal(done.error.code, "stalled")
      // Guards against a busy answer counting as progress: the call would never stop.
      assert.ok(Date.now() - began < 8000, `took ${Date.now() - began} ms`)
      assert.ok(probes(services.asked).length >= 6, String(probes(services.asked).length))
      assert.ok(closest(services.asked) >= 950, `probed again after ${closest(services.asked)} ms`)
      assert.ok(waitedOn(engine.sent).some((state) => state.busy))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "an answer arriving slowly is progress, so the call goes on past the time it may make none",
  { skip: !python3 },
  async () => {
    const services = await serve({
      overpass: (query) =>
        isProbe(query)
          ? answer([])
          : { trickle: { osm3s: { timestamp_osm_base: fresh() }, elements: [count(4)] }, pieces: 6, every: 600 },
    })
    const engine = await start(python3!, services.services, { stall: 2 })
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(done.ok, JSON.stringify(done))
      assert.equal((done.result as { rows: { total: number }[] }).rows[0].total, 4)
      const received = told(engine.sent, "received").map(
        (message) => (message.data as { osm: { bytes: number } }).osm.bytes,
      )
      // Told as it arrives, not once at the end.
      assert.ok(new Set(received).size > 2, JSON.stringify(received))
      assert.deepEqual(
        [...received].sort((a, b) => a - b),
        received,
      )
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a look the server stopped early keeps the counts it got to and names those it did not, with the server's words",
  { skip: !python3 },
  async () => {
    const remark = 'runtime error: Query timed out in "query" at line 1 after 60 seconds.'
    let elements = [count(4)]
    const services = await serve({ overpass: () => answer(elements, { remark }) })
    const engine = await start(python3!, services.services)
    type Looked = { rows: object[]; uncounted: string[] }
    try {
      const tags = await engine.call("probe", { area: BOX, tags: ["building", "amenity"] })
      assert.ok(tags.ok, JSON.stringify(tags))
      // Guards against the one count that came back being given as the count of either filter, or the filter not
      // counted vanishing as if it were not a way of tagging it.
      assert.deepEqual(tags.result, {
        area: BOX,
        rows: [{ nodes: 4, ways: 0, relations: 0, total: 4, filter: "building" }],
        uncounted: ["amenity"],
        together: null,
        remark,
      })
      const term = await engine.call("probe", { area: BOX, term: "hospital" })
      assert.ok(term.ok, JSON.stringify(term))
      const counted = term.result as Looked
      assert.equal(counted.rows.length, 1)
      assert.ok(counted.uncounted.length > 0, JSON.stringify(counted))
      elements = []
      // Guards against a call that got no count at all failing as if GeoCode were broken.
      const none = await engine.call("probe", { area: BOX, tags: ["building", "amenity"] })
      assert.deepEqual(none.ok && none.result, {
        area: BOX,
        rows: [],
        uncounted: ["building", "amenity"],
        together: null,
        remark,
      })
      // Guards against a word the server stopped before counting being taken for one OSM has no tags for.
      const unknown = await engine.call("probe", { area: BOX, term: "hospital" })
      assert.ok(unknown.ok, JSON.stringify(unknown))
      const looked = unknown.result as Looked
      assert.deepEqual(
        [looked.rows.length, looked.uncounted.length],
        [0, counted.rows.length + counted.uncounted.length],
      )
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "an answer broken off as it arrived was progress, so the call goes on to another instance",
  { skip: !python3 },
  async () => {
    const probed = [0, 0, 0]
    const services = await serve({
      overpass: (query, index) => {
        if (index === 2) return { status: 404, body: "moved" }
        if (isProbe(query)) {
          probed[index] += 1
          if (probed[index] === 1) return { status: 503, body: "busy" }
          // The second probes find the first instance free before the other.
          return index === 0 ? answer([]) : { after: 300, reply: answer([]) }
        }
        // A piece, then silence longer than what the call had left to wait when it asked.
        return index === 0
          ? { trickle: { osm3s: { timestamp_osm_base: fresh() }, elements: [count(4)] }, pieces: 2, every: 4000 }
          : counts(4)
      },
    })
    // After the pause, the query may wait about 3 seconds.
    const engine = await start(python3!, services.services, { stall: 5, pause: 2 })
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      // Guards against the piece that arrived counting for nothing: the call would stop as having made no progress.
      assert.ok(done.ok, JSON.stringify({ done, asked: queried(services.asked) }))
      assert.deepEqual(queried(services.asked), [0, 1])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test("looks wait for the one before them, and their rows are told so", { skip: !python3 }, async () => {
  const OTHER = "bbox:25.03,121.51,25.05,121.53"
  const services = await serve({
    overpass: (query) => (isProbe(query) ? answer([]) : { after: 1000, reply: counts(4) }),
  })
  const engine = await start(python3!, services.services)
  try {
    const first = engine.send("probe", { area: BOX, tags: ["building"] })
    const second = engine.send("probe", { area: OTHER, tags: ["building"] })
    assert.ok((await engine.response(first)).ok)
    assert.ok((await engine.response(second)).ok)
    const asked = (box: string) =>
      services.asked.find((request) => !isProbe(request.query) && request.query.includes(box.slice(5, 10)))!.at
    // Guards against two calls asking the instances at once from the same address.
    assert.ok(asked(OTHER) - asked(BOX) >= 1000, `${asked(OTHER) - asked(BOX)} ms apart`)
    const types = engine.sent.flatMap((message) =>
      message.type === "progress" && message.id === second
        ? [(message.data as { osm: { type: string } }).osm.type]
        : [],
    )
    assert.deepEqual(types.slice(0, 2), ["queued", "started"])
    assert.ok(!told(engine.sent, "queued").some((message) => (message as { id?: number }).id === first))
  } finally {
    await engine.stop()
    await services.close()
  }
})

test("a look cancelled while it waits ends at once, the one before it going on", { skip: !python3 }, async () => {
  const services = await serve({
    overpass: (query) => (isProbe(query) ? answer([]) : { after: 3000, reply: counts(4) }),
  })
  const engine = await start(python3!, services.services)
  try {
    const first = engine.send("probe", { area: BOX, tags: ["building"] })
    const second = engine.send("probe", { area: BOX, tags: ["amenity"] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const began = Date.now()
    engine.cancel(second)
    const cancelled = await engine.response(second)
    // Guards against a cancelled call waiting its turn, then starting all the same.
    assert.ok(Date.now() - began < 1500, `took ${Date.now() - began} ms`)
    assert.ok(!cancelled.ok)
    assert.equal(cancelled.error.code, "cancelled")
    assert.ok((await engine.response(first)).ok)
    assert.equal(queried(services.asked).length, 1)
  } finally {
    await engine.stop()
    await services.close()
  }
})

test(
  "the row is told when a query is out and when its answer arrives, rather than how little of it has come",
  { skip: !python3 },
  async () => {
    const services = await serve({
      overpass: (query, index) => {
        if (index > 0) return { status: 404, body: "moved" }
        if (isProbe(query)) return answer([])
        const padding = "x".repeat(200 * 1024)
        return {
          trickle: { osm3s: { timestamp_osm_base: fresh() }, elements: [count(4)], padding },
          pieces: 5,
          every: 600,
        }
      },
    })
    const engine = await start(python3!, services.services)
    try {
      assert.ok((await engine.call("probe", { area: BOX, tags: ["building"] })).ok)
      const states = waitedOn(engine.sent)
      // Guards against the head of an answer reading as the answer arriving, a query out reading as nothing, and an
      // answer taken reading for a moment as a query the server is still working on.
      assert.deepEqual(states, [
        { asking: true, arriving: false, busy: false },
        { asking: true, arriving: true, busy: false },
        { asking: false, arriving: false, busy: false },
      ])
      const progress = engine.sent.filter((message) => message.type === "progress")
      const arriving = progress.findIndex((message) => {
        const osm = (message.data as { osm: { type: string; arriving?: boolean } }).osm
        return osm.type === "server" && osm.arriving
      })
      const before = progress
        .slice(0, arriving)
        .map((message) => (message.data as { osm: { type: string; bytes?: number } }).osm)
        .filter((osm) => osm.type === "received")
      assert.ok((before.at(-1)?.bytes ?? 0) >= 64 * 1024, JSON.stringify(before))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a busy instance's probe does not tell the row the servers are busy while another works on the query",
  { skip: !python3 },
  async () => {
    const services = await serve({
      overpass: (query, index) => {
        if (index === 2) return { status: 404, body: "moved" }
        if (index === 0) return { after: 300, reply: { status: 503, body: "busy" } }
        return isProbe(query) ? answer([]) : { after: 1000, reply: counts(4) }
      },
    })
    const engine = await start(python3!, services.services)
    try {
      assert.ok((await engine.call("probe", { area: BOX, tags: ["building"] })).ok)
      // Guards against an instance found busy making the row say every server is busy while another works on the query.
      assert.ok(!waitedOn(engine.sent).some((state) => state.busy), JSON.stringify(waitedOn(engine.sent)))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test("an instance found busy is not asked by the next call before its pause ends", { skip: !python3 }, async () => {
  const services = await serve({
    overpass: (query, index) => (index === 0 ? { status: 429, body: "rate limited" } : counts(4)),
  })
  const engine = await start(python3!, services.services, { pause: 10 })
  try {
    assert.ok((await engine.call("probe", { area: BOX, tags: ["building"] })).ok)
    const first = services.asked.length
    assert.ok((await engine.call("probe", { area: BOX, tags: ["amenity"] })).ok)
    // Guards against each call keeping its own pauses: the next would ask at once an instance that just said 429.
    assert.ok(!overpass(services.asked.slice(first)).some((request) => instanceOf(request) === 0))
  } finally {
    await engine.stop()
    await services.close()
  }
})

test(
  "an area written wrong is refused with how to write it, before Overpass is asked",
  { skip: !python3 },
  async () => {
    const services = await serve({ overpass: () => answer([]) })
    const engine = await start(python3!, services.services)
    try {
      const done = await engine.call("probe", { area: "bbox:121.36,24.93,121.39,24.96", tags: ["building"] })
      assert.ok(!done.ok)
      assert.equal(done.error.code, "invalid")
      assert.deepEqual(overpass(services.asked), [])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)
