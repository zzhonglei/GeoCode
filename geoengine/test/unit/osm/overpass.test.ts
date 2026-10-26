import assert from "node:assert/strict"
import { test } from "node:test"
import { answer, counts, fresh, serve, start } from "../../support/osm.ts"
import { python3 } from "../../support/python.ts"

const BOX = "bbox:24.93,121.36,24.96,121.39"

/** One statement's element in Overpass's answer to `out count`. */
const count = (total: number) => ({
  type: "count",
  id: 0,
  tags: { nodes: String(total), ways: "0", relations: "0", total: String(total) },
})

const instances = (asked: { service: string; where: string }[]) =>
  asked.filter((request) => request.service === "overpass").map((request) => Number(request.where.split("/")[0]))

test(
  "a busy instance and one with old data are passed over, and the next call starts from the one that answered",
  { skip: !python3 },
  async () => {
    const stale = { osm3s: { timestamp_osm_base: "2020-01-01T00:00:00Z" }, elements: [] }
    const services = await serve({
      overpass: (_query, instance) =>
        instance === 0 ? { status: 502, body: "at capacity" } : instance === 1 ? { json: stale } : counts(4),
    })
    const engine = await start(python3!, services.services)
    try {
      const first = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(first.ok, JSON.stringify(first))
      assert.equal((first.result as { rows: { total: number }[] }).rows[0].total, 4)
      assert.deepEqual(instances(services.asked), [0, 1, 2])
      // Guards against every call waiting out the instances an earlier one found failing.
      assert.ok((await engine.call("probe", { area: BOX, tags: ["building"] })).ok)
      assert.deepEqual(instances(services.asked), [0, 1, 2, 2])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test("when every instance fails, only those that said they were busy are asked again", { skip: !python3 }, async () => {
  const stale = { osm3s: { timestamp_osm_base: "2020-01-01T00:00:00Z" }, elements: [] }
  let asked = 0
  const services = await serve({
    overpass: (_query, instance) => {
      asked += 1
      if (instance === 0) return { status: 404, body: "moved" }
      if (instance === 1) return { json: stale }
      // The last instance is busy at first and answers on the second round.
      return asked > 3 ? counts(4) : { status: 503, body: "busy" }
    },
  })
  const engine = await start(python3!, services.services)
  try {
    assert.ok((await engine.call("probe", { area: BOX, tags: ["building"] })).ok)
    // Guards against asking again an instance whose data is old, or that answered with something other than busy.
    assert.deepEqual(instances(services.asked), [0, 1, 2, 2])
  } finally {
    await engine.stop()
    await services.close()
  }
})

test("an instance that answers with something other than JSON is not asked again", { skip: !python3 }, async () => {
  let asked = 0
  const services = await serve({
    overpass: (_query, instance) => {
      asked += 1
      if (instance === 0) return { status: 200, body: "<html>Welcome</html>" }
      return asked > 3 ? counts(4) : { status: 503, body: "busy" }
    },
  })
  const engine = await start(python3!, services.services)
  try {
    assert.ok((await engine.call("probe", { area: BOX, tags: ["building"] })).ok)
    // Guards against a page that is not an answer being taken for a busy instance, and asked again each round.
    assert.deepEqual(instances(services.asked), [0, 1, 2, 1])
  } finally {
    await engine.stop()
    await services.close()
  }
})

test(
  "a query Overpass refuses is answered with its own words, no other instance asked",
  { skip: !python3 },
  async () => {
    const page = '<p><strong style="color:#FF0000">Error</strong>: line 1: parse error: Invalid regular expression</p>'
    const services = await serve({ overpass: () => ({ status: 400, body: page }) })
    const engine = await start(python3!, services.services)
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["name~("] })
      assert.ok(!done.ok)
      assert.equal(done.error.code, "refused")
      assert.match(done.error.message, /Invalid regular expression/)
      assert.deepEqual(instances(services.asked), [0])
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
    const engine = await start(python3!, services.services, 2)
    try {
      const began = Date.now()
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(!done.ok)
      assert.equal(done.error.code, "stalled")
      assert.deepEqual(done.error.details, { seconds: 2 })
      // Guards against each silent instance being waited out for the query's own time limit.
      assert.ok(Date.now() - began < 10000, `took ${Date.now() - began} ms`)
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "instances that keep saying they are busy are asked again, and their answers are no progress",
  { skip: !python3 },
  async () => {
    const services = await serve({ overpass: () => ({ status: 503, body: "busy" }) })
    // Long enough for a second round after the first pause.
    const engine = await start(python3!, services.services, 7)
    try {
      const began = Date.now()
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(!done.ok)
      assert.equal(done.error.code, "stalled")
      // Guards against a busy answer counting as progress: the call would run on to the end of the next pause.
      assert.ok(Date.now() - began < 10000, `took ${Date.now() - began} ms`)
      assert.deepEqual(instances(services.asked), [0, 1, 2, 0, 1, 2])
      const busy = engine.sent.filter(
        (message) => message.type === "progress" && (message.data as { osm: { type: string } }).osm.type === "busy",
      )
      assert.equal(busy.length, 6)
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
      overpass: () => ({
        trickle: { osm3s: { timestamp_osm_base: fresh() }, elements: [count(4)] },
        pieces: 6,
        every: 600,
      }),
    })
    const engine = await start(python3!, services.services, 2)
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      assert.ok(done.ok, JSON.stringify(done))
      assert.equal((done.result as { rows: { total: number }[] }).rows[0].total, 4)
      const received = engine.sent.flatMap((message) =>
        message.type === "progress" && (message.data as { osm: { type: string } }).osm.type === "received"
          ? [(message.data as { osm: { bytes: number } }).osm.bytes]
          : [],
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
  "an answer broken off as it arrived was progress, so the call goes on to the next instance",
  { skip: !python3 },
  async () => {
    let rounds = 0
    const services = await serve({
      overpass: (_query, instance) => {
        if (instance === 0) rounds += 1
        if (rounds === 1) return { status: 503, body: "busy" }
        // A piece, then silence longer than what the call had left to wait when it asked.
        if (instance === 0) {
          return { trickle: { osm3s: { timestamp_osm_base: fresh() }, elements: [count(4)] }, pieces: 2, every: 4000 }
        }
        return counts(4)
      },
    })
    // After the first round's pause, the next request may wait about 3 seconds.
    const engine = await start(python3!, services.services, 8)
    try {
      const done = await engine.call("probe", { area: BOX, tags: ["building"] })
      // Guards against the piece that arrived counting for nothing: the call would stop as having made no progress.
      assert.ok(done.ok, JSON.stringify({ done, asked: instances(services.asked) }))
      assert.deepEqual(instances(services.asked), [0, 1, 2, 0, 1])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

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
      assert.deepEqual(instances(services.asked), [])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)
