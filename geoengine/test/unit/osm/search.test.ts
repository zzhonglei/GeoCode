import assert from "node:assert/strict"
import { test } from "node:test"
import { Geocodekit } from "../../../src/python/geocodekit.ts"
import { answer, instanceOf, isProbe, serve, start, type Reply } from "../../support/osm.ts"
import { python3 } from "../../support/common.ts"

const campus = { lat: "24.9387", lon: "121.3615" }

/** Nominatim describing the university, a station named after it and a park, as its lookup does. */
const nominatim = (where: string, params: URLSearchParams): Reply => {
  if (where === "search") {
    return {
      json: [
        // Better known than the park, and found by two services: only its being a station puts it after the park.
        { osm_type: "node", osm_id: 7, importance: 0.6 },
        { osm_type: "relation", osm_id: 1, importance: 0.5 },
      ],
    }
  }
  const described: Record<string, object> = {
    R1: {
      osm_type: "relation",
      osm_id: 1,
      category: "amenity",
      type: "university",
      ...campus,
      boundingbox: ["24.9387", "24.9477", "121.3615", "121.3740"],
      namedetails: { name: "國立臺北大學", "name:en": "National Taipei University" },
      extratags: { wikidata: "Q707456" },
      address: { city: "New Taipei", country: "Taiwan" },
    },
    N7: {
      osm_type: "node",
      osm_id: 7,
      category: "railway",
      type: "station",
      ...campus,
      boundingbox: ["24.9389", "24.9389", "121.3671", "121.3671"],
      namedetails: { name: "臺北大學" },
      extratags: { public_transport: "station" },
      address: { city: "New Taipei", country: "Taiwan" },
    },
    W5: {
      osm_type: "way",
      osm_id: 5,
      category: "leisure",
      type: "park",
      ...campus,
      boundingbox: ["24.94", "24.95", "121.36", "121.37"],
      namedetails: { name: "臺北大學公園" },
      address: { town: "Sanxia", country: "Taiwan" },
    },
  }
  const ids = (params.get("osm_ids") ?? "").split(",")
  return { json: ids.flatMap((id) => (described[id] ? [described[id]] : [])) }
}

const photon = (): Reply => ({
  json: {
    features: [
      { properties: { osm_type: "R", osm_id: 1 } },
      { properties: { osm_type: "W", osm_id: 5 } },
      { properties: { osm_type: "N", osm_id: 7 } },
    ],
  },
})

const wikidata = (params: URLSearchParams): Reply =>
  params.get("action") === "wbsearchentities"
    ? { json: { search: [{ id: "Q707456" }] } }
    : { json: { entities: { Q707456: { descriptions: { en: { value: "national university in Taiwan" } } } } } }

/** Overpass finding the university by its Wikidata item. */
const overpass = (query: string): Reply =>
  query.includes('"wikidata"="Q707456"')
    ? answer([
        {
          type: "relation",
          id: 1,
          tags: {
            type: "multipolygon",
            amenity: "university",
            education: "university",
            name: "國立臺北大學",
            wikidata: "Q707456",
          },
          bounds: { minlat: 24.9387, minlon: 121.3615, maxlat: 24.9477, maxlon: 121.374 },
        },
      ])
    : answer([])

const ids = (result: unknown) => (result as { candidates: { id: string }[] }).candidates.map((found) => found.id)

test(
  "a search puts the place before what is named after it, each candidate described alike",
  { skip: !python3 },
  async () => {
    const services = await serve({ nominatim, photon, wikidata, overpass })
    const engine = await start(python3!, services.services)
    try {
      const done = await engine.call("search", { name: "國立臺北大學" })
      assert.ok(done.ok, JSON.stringify(done))
      // Guards against a stop or station named after the place outranking it, as they outnumber it.
      assert.deepEqual(ids(done.result), ["R1", "W5", "N7"])
      const [first] = (done.result as { candidates: Record<string, unknown>[] }).candidates
      assert.equal(first.location, "New Taipei, Taiwan")
      // Guards against the newer of two ways of tagging the same thing being given: most such objects in OSM lack it.
      assert.equal(first.category, "amenity=university")
      assert.equal(first.name_en, "National Taipei University")
      assert.equal(first.description, "national university in Taiwan")
      assert.equal((done.result as { incomplete: boolean }).incomplete, false)
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a service that does not answer leaves the others' candidates, said to be incomplete",
  { skip: !python3 },
  async () => {
    const services = await serve({ nominatim, wikidata, overpass, photon: () => ({ status: 503, body: "busy" }) })
    const engine = await start(python3!, services.services)
    try {
      const done = await engine.call("search", { name: "國立臺北大學" })
      assert.ok(done.ok, JSON.stringify(done))
      assert.ok(ids(done.result).includes("R1"))
      assert.equal((done.result as { incomplete: boolean }).incomplete, true)
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a search Nominatim stops answering partway through is said to be incomplete, and so is a place it did not look up",
  { skip: !python3 },
  async () => {
    const busy: Reply = { status: 503, body: "busy" }
    let fails = (_where: string, _params: URLSearchParams) => false
    const services = await serve({
      nominatim: (where, params) => (fails(where, params) ? busy : nominatim(where, params)),
      photon,
      wikidata,
      overpass,
    })
    const engine = await start(python3!, services.services)
    try {
      fails = (where) => where === "lookup"
      const described = await engine.call("search", { name: "國立臺北大學" })
      assert.ok(described.ok, JSON.stringify(described))
      // Guards against the candidates Nominatim could not describe vanishing as if nothing had been found.
      assert.ok(ids(described.result).includes("R1"))
      assert.equal((described.result as { incomplete: boolean }).incomplete, true)
      fails = (where, params) => where === "search" && params.get("q") === "新北市"
      const placed = await engine.call("search", { name: "國立臺北大學", context: "新北市" })
      assert.ok(placed.ok, JSON.stringify(placed))
      const result = placed.result as { context_found: boolean | null; incomplete: boolean }
      // Guards against a place that was never looked up being reported as one that does not exist.
      assert.deepEqual([result.context_found, result.incomplete], [null, true])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a search that leaves out a candidate no service described is said to be incomplete",
  { skip: !python3 },
  async () => {
    const undescribed = (): Reply => ({
      json: {
        features: [{ properties: { osm_type: "R", osm_id: 1 } }, { properties: { osm_type: "W", osm_id: 9 } }],
      },
    })
    const services = await serve({ nominatim, photon: undescribed, wikidata, overpass })
    const engine = await start(python3!, services.services)
    try {
      const done = await engine.call("search", { name: "國立臺北大學" })
      assert.ok(done.ok, JSON.stringify(done))
      assert.ok(ids(done.result).includes("R1"))
      // Guards against an answer without the dropped candidate passing for a complete one.
      assert.equal((done.result as { incomplete: boolean }).incomplete, true)
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a name Overpass stopped matching partway through is said to be incomplete, not absent",
  { skip: !python3 },
  async () => {
    const remark = 'runtime error: Query timed out in "query" at line 1 after 25 seconds.'
    const services = await serve({
      nominatim: (where, params) => (where === "search" ? { json: [] } : nominatim(where, params)),
      photon: () => ({ json: { features: [] } }),
      wikidata: () => ({ json: { search: [] } }),
      overpass: (query) => (query.includes('["name"~') ? answer([], { remark }) : answer([])),
    })
    const engine = await start(python3!, services.services)
    try {
      const done = await engine.call("search", { name: "臺北大學", context: "R1" })
      assert.ok(done.ok, JSON.stringify(done))
      // Guards against missing the remark Overpass stops with, which would tell the model nothing has this name.
      assert.equal((done.result as { incomplete: boolean }).incomplete, true)
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "every request names GeoCode and its version, and Nominatim is asked once a second at most across calls",
  { skip: !python3 },
  async () => {
    const services = await serve({ nominatim, photon, wikidata, overpass })
    const engine = await start(python3!, services.services)
    try {
      // Two searches at once, each asking Nominatim twice: the services' limits count the app's calls together.
      const calls = [engine.send("search", { name: "國立臺北大學" }), engine.send("search", { name: "臺北大學" })]
      for (const id of calls) assert.ok((await engine.response(id)).ok)
      // Guards against a library's default agent, which the services refuse, or one telling users apart.
      const agents = new Set(services.asked.map((request) => request.agent))
      assert.deepEqual(
        [...agents],
        [`GeoCode/${Geocodekit.PACKAGE.version} (+https://github.com/zzhonglei/GeoCode)`],
      )
      const times = services.asked.filter((request) => request.service === "nominatim").map((request) => request.at)
      assert.equal(times.length, 4)
      for (let index = 1; index < times.length; index++)
        assert.ok(times[index] - times[index - 1] >= 990, String(times))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a name Wikidata matches in other characters than OSM's puts its object first, with Overpass not answering",
  { skip: !python3 },
  async () => {
    // Two universities Nominatim finds for the simplified name, the better known first; Wikidata matches the other.
    const universities = (where: string, params: URLSearchParams): Reply => {
      const described = {
        R1: { osm_id: 1, name: "國立臺北大學", importance: 0.3, wikidata: "Q707456" },
        R2: { osm_id: 2, name: "國立臺灣大學", importance: 0.7, wikidata: "Q32746" },
      }
      const shown = Object.entries(described).filter(
        ([id]) => where === "search" || (params.get("osm_ids") ?? "").split(",").includes(id),
      )
      return {
        json: shown.map(([, university]) => ({
          osm_type: "relation",
          osm_id: university.osm_id,
          importance: university.importance,
          category: "amenity",
          type: "university",
          ...campus,
          boundingbox: ["24.9387", "24.9477", "121.3615", "121.3740"],
          namedetails: { name: university.name },
          extratags: { wikidata: university.wikidata },
          address: { city: "Taipei", country: "Taiwan" },
        })),
      }
    }
    const matched = (params: URLSearchParams): Reply =>
      params.get("action") === "wbsearchentities"
        ? { json: { search: [{ id: "Q707456", match: { type: "alias", language: "zh", text: "国立台北大学" } }] } }
        : { json: { entities: {} } }
    const services = await serve({
      nominatim: universities,
      wikidata: matched,
      // Photon finds the other one too: only the name Wikidata matched can put the right one first.
      photon: () => ({ json: { features: [{ properties: { osm_type: "R", osm_id: 2 } }] } }),
      overpass: () => ({ status: 504, body: "busy" }),
    })
    const engine = await start(python3!, services.services)
    try {
      const done = await engine.call("search", { name: "国立台北大学" })
      assert.ok(done.ok, JSON.stringify(done))
      // Guards against comparing names character by character alone: simplified and traditional share few.
      assert.deepEqual(ids(done.result), ["R1", "R2"])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test("a search asks first the Overpass instance that answered the call before it", { skip: !python3 }, async () => {
  const services = await serve({
    nominatim,
    photon,
    wikidata,
    // The last instance's probe answers first, so the look's query goes to it; none is found busy.
    overpass: (query, index) => (index !== 2 && isProbe(query) ? { after: 300, reply: answer([]) } : overpass(query)),
  })
  const engine = await start(python3!, services.services)
  try {
    assert.ok((await engine.call("probe", { area: "bbox:24.93,121.36,24.96,121.39", tags: ["building"] })).ok)
    const before = services.asked.length
    assert.ok((await engine.call("search", { name: "國立臺北大學" })).ok)
    const first = services.asked.slice(before).find((request) => request.service === "overpass")
    // Guards against each search waiting out first an instance the call before it found busy.
    assert.equal(first && instanceOf(first), 2)
  } finally {
    await engine.stop()
    await services.close()
  }
})

test("a search does not ask an instance an earlier call found busy", { skip: !python3 }, async () => {
  let searching = false
  const services = await serve({
    nominatim,
    photon,
    wikidata,
    overpass: (query, index) => {
      if (index === 0) return { status: 503, body: "busy" }
      // The look's query goes to the last instance, whose probe answers first; the search finds it busy.
      if (index === 1) return isProbe(query) ? { after: 300, reply: answer([]) } : overpass(query)
      return searching ? { status: 503, body: "busy" } : overpass(query)
    },
  })
  const engine = await start(python3!, services.services, { pause: 10 })
  try {
    assert.ok((await engine.call("probe", { area: "bbox:24.93,121.36,24.96,121.39", tags: ["building"] })).ok)
    searching = true
    const before = services.asked.length
    assert.ok((await engine.call("search", { name: "國立臺北大學" })).ok)
    const asked = services.asked.slice(before).filter((request) => request.service === "overpass")
    // Guards against a search asking at once the instance a call before it found busy, as the policy asks not to.
    assert.ok(!asked.some((request) => instanceOf(request) === 0), JSON.stringify(asked.map(instanceOf)))
    assert.deepEqual([...new Set(asked.map(instanceOf))], [2, 1])
  } finally {
    await engine.stop()
    await services.close()
  }
})

test(
  "an instance a search finds busy is not asked by the next call before its pause ends",
  { skip: !python3 },
  async () => {
    const services = await serve({
      nominatim,
      photon,
      wikidata,
      overpass: (query, index) => (index === 0 ? { status: 429, body: "rate limited" } : overpass(query)),
    })
    const engine = await start(python3!, services.services, { pause: 10 })
    try {
      assert.ok((await engine.call("search", { name: "國立臺北大學" })).ok)
      const before = services.asked.length
      assert.ok((await engine.call("probe", { area: "bbox:24.93,121.36,24.96,121.39", tags: ["building"] })).ok)
      const asked = services.asked.slice(before).filter((request) => request.service === "overpass")
      // Guards against a search's 429 going unheeded: the next call would ask that instance at once.
      assert.ok(!asked.some((request) => instanceOf(request) === 0), JSON.stringify(asked.map(instanceOf)))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)
