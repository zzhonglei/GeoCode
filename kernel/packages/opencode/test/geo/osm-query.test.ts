import { describe, expect, test } from "bun:test"
import { OsmExtent } from "@/geo/osm/extent"
import { OsmQuery } from "@/geo/osm/query"

/* Query building and the extent contract (docs/GEOKERNEL.md §6.4, §6.5). Pure functions throughout, so every rule
 * is pinned exactly — including the one the module exists for: a reduced boundary is never smaller than the
 * boundary it reduces. */

describe("osm identifiers", () => {
  test("reads the three prefixes and refuses the rest", () => {
    expect(OsmQuery.parseRef("R10717504")).toEqual({ type: "relation", id: 10717504 })
    expect(OsmQuery.parseRef("w123")).toEqual({ type: "way", id: 123 })
    expect(OsmQuery.parseRef(" N456 ")).toEqual({ type: "node", id: 456 })
    for (const bad of ["10717504", "X1", "R", "R0", "R-3", "Rabc"]) {
      expect(() => OsmQuery.parseRef(bad)).toThrow()
    }
  })

  test("an area from a way is refused loudly, not answered emptily", () => {
    expect(OsmQuery.areaId({ type: "relation", id: 10717504 })).toBe(3_610_717_504)
    expect(() => OsmQuery.areaId({ type: "way", id: 123 })).toThrow(/only exist for relations/)
    expect(() => OsmQuery.areaId({ type: "node", id: 123 })).toThrow()
  })
})

describe("osm tag filters", () => {
  test("the accepted forms all reach bracket syntax", () => {
    expect(OsmQuery.tagClause("amenity=hospital")).toBe('["amenity"="hospital"]')
    expect(OsmQuery.tagClause("healthcare")).toBe('["healthcare"]')
    expect(OsmQuery.tagClause("highway~primary|trunk")).toBe('["highway"~"primary|trunk"]')
    expect(OsmQuery.tagClause('["amenity"="clinic"]')).toBe('["amenity"="clinic"]')
    expect(() => OsmQuery.tagClause("  ")).toThrow()
  })

  test("a quote in a value cannot break out of the literal", () => {
    expect(OsmQuery.tagClause('name=say "hi"')).toBe('["name"="say \\"hi\\""]')
    expect(OsmQuery.tagClause("path=C:\\temp")).toBe('["path"="C:\\\\temp"]')
  })

  test("the key comes back out of every form", () => {
    expect(OsmQuery.tagKey("amenity=hospital")).toBe("amenity")
    expect(OsmQuery.tagKey("healthcare")).toBe("healthcare")
    expect(OsmQuery.tagKey("highway~primary")).toBe("highway")
    expect(OsmQuery.tagKey('["amenity"="clinic"]')).toBe("amenity")
  })
})

describe("osm name search", () => {
  test("a name is matched literally, metacharacters and all", () => {
    const ql = OsmQuery.nameSearch({ query: "成都(高新)店", timeoutSec: 30 })
    expect(ql).toContain("成都\\\\(高新\\\\)店")
    expect(ql).not.toContain('"成都(高新)店"')
  })

  test("case folding is spent only where case exists", () => {
    expect(OsmQuery.nameSearch({ query: "harvard university", timeoutSec: 30 })).toContain('",i]')
    expect(OsmQuery.nameSearch({ query: "武汉大学", timeoutSec: 30 })).not.toContain(",i")
  })

  test("relations are emitted before the noisier types", () => {
    const ql = OsmQuery.nameSearch({ query: "武汉", timeoutSec: 30 })
    const relation = ql.indexOf("rel[")
    const way = ql.indexOf("way[")
    const node = ql.indexOf("node[")
    expect(relation).toBeLessThan(way)
    expect(way).toBeLessThan(node)
    expect(ql).toContain("out tags center 15;")
  })

  test("a deliberately built regex is not escaped again", () => {
    const ql = OsmQuery.nameSearch({ query: "武汉市|武汉", rawRegex: true, timeoutSec: 30 })
    expect(ql).toContain("武汉市|武汉")
  })
})

describe("osm query shapes", () => {
  const spatial = { prelude: "", filters: ["(30,114,31,115)"] }

  test("every filter, type and tag becomes its own clause", () => {
    const ql = OsmQuery.download({
      spatial: { prelude: "", filters: ["(30,114,31,115)", "(31,115,32,116)"] },
      tags: ["amenity=school", "amenity=hospital"],
      types: ["way", "relation"],
      timeoutSec: 60,
    })
    // Two areas × two types × two tags.
    expect(ql.split("\n").filter((line) => line.trim().startsWith("way") || line.trim().startsWith("rel")).length).toBe(
      8,
    )
    expect(ql).toContain("out geom;")
  })

  test("counting moves no geometry, and stats ask for tags only", () => {
    expect(OsmQuery.count({ spatial, tags: ["amenity"], types: ["nwr"], timeoutSec: 30 })).toContain("out count;")
    const stats = OsmQuery.tagStats({ spatial, key: "amenity", types: ["nwr"], timeoutSec: 30, sampleLimit: 1000 })
    expect(stats).toContain("out tags 1000;")
    expect(stats).not.toContain("geom")
  })

  test("a batch of ids groups by type and inlines geometry", () => {
    const ql = OsmQuery.objects({
      refs: [
        { type: "relation", id: 1 },
        { type: "relation", id: 2 },
        { type: "way", id: 9 },
      ],
      timeoutSec: 60,
    })
    expect(ql).toContain("rel(id:1,2);")
    expect(ql).toContain("way(id:9);")
    expect(ql).toContain("out geom;")
  })
})

describe("osm extent forms", () => {
  test("each kind resolves, and an unprefixed string is refused", () => {
    expect(OsmExtent.parse("area:R10717504").spatial.prelude).toBe("area(3610717504)->.a;")
    expect(OsmExtent.parse("bbox:30.5,114.3,30.6,114.4").spatial.filters).toEqual(["(30.5,114.3,30.6,114.4)"])
    expect(OsmExtent.parse("around:1000,30.5,114.3").spatial.filters).toEqual(["(around:1000,30.5,114.3)"])
    for (const bad of ["R10717504", "region:x", "bbox:1,2,3", "bbox:31,114,30,115", "around:0,30,114"]) {
      expect(() => OsmExtent.parse(bad)).toThrow()
    }
  })

  test("the three precise forms say so", () => {
    expect(OsmExtent.parse("area:R1").exact).toBe(true)
    expect(OsmExtent.parse("bbox:30,114,31,115").exact).toBe(true)
    expect(OsmExtent.parse("around:500,30,114").exact).toBe(true)
  })
})

describe("osm boundary files and the superset rule", () => {
  const square = (cx: number, cy: number, r: number) => [
    [cx - r, cy - r],
    [cx + r, cy - r],
    [cx + r, cy + r],
    [cx - r, cy + r],
    [cx - r, cy - r],
  ]
  const asFile = (geometry: object) => JSON.stringify({ type: "Feature", geometry, properties: {} })

  test("a small ring is passed through exactly", () => {
    const resolved = OsmExtent.parse("file:/b.geojson", () =>
      asFile({ type: "Polygon", coordinates: [square(114, 30, 0.1)] }),
    )
    expect(resolved.exact).toBe(true)
    expect(resolved.spatial.filters[0]).toContain("poly:")
    // Overpass reads latitude first; a transposed pair queries the wrong hemisphere with no error.
    expect(resolved.spatial.filters[0]).toContain("29.9 113.9")
  })

  test("every part of a multi-part boundary is queried", () => {
    const resolved = OsmExtent.parse("file:/b.geojson", () =>
      asFile({ type: "MultiPolygon", coordinates: [[square(114, 30, 0.1)], [square(116, 32, 0.1)]] }),
    )
    expect(resolved.spatial.filters).toHaveLength(2)
    expect(resolved.exact).toBe(true)
  })

  test("an oversized ring becomes its hull, and the hull CONTAINS it", () => {
    // Past the 300-vertex budget, with the shape real boundaries have: local wiggle on one edge, four corners of
    // actual extent.
    const comb: [number, number][] = [[113.5, 29.5]]
    for (let i = 0; i <= 400; i++) {
      const x = 113.5 + (i / 400) * 1
      comb.push([x, 29.5 + (i % 2 === 0 ? 0.02 : 0)])
    }
    comb.push([114.5, 30.5], [113.5, 30.5], [113.5, 29.5])

    const resolved = OsmExtent.parse("file:/b.geojson", () => asFile({ type: "Polygon", coordinates: [comb] }))
    expect(resolved.exact).toBe(false)
    expect(resolved.spatial.filters[0]).toContain("poly:")

    const hull = OsmExtent.convexHull(comb)
    // The rule, checked rather than asserted: a line simplifier would meet the budget too, by cutting inward (§6.4).
    expect(OsmExtent.containsAll(hull, comb)).toBe(true)
    expect(hull.length).toBeLessThan(comb.length)
  })

  test("a ring that is already convex cannot shrink, and falls back to its box", () => {
    const circle: [number, number][] = []
    for (let i = 0; i <= 500; i++) {
      const angle = (i / 500) * Math.PI * 2
      circle.push([114 + Math.cos(angle) * 0.5, 30 + Math.sin(angle) * 0.5])
    }
    const resolved = OsmExtent.parse("file:/b.geojson", () => asFile({ type: "Polygon", coordinates: [circle] }))

    expect(resolved.exact).toBe(false)
    expect(resolved.spatial.filters[0]).toMatch(/^\(29\.5,113\.5,30\.5,114\.5\)$/)
    const [south, west, north, east] = resolved.spatial.filters[0]!.slice(1, -1).split(",").map(Number) as [
      number,
      number,
      number,
      number,
    ]
    const box: [number, number][] = [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ]
    expect(OsmExtent.containsAll(box, circle)).toBe(true)
  })

  test("a concave boundary keeps its notch inside the hull", () => {
    const c: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 4],
      [2, 1],
      [0, 4],
      [0, 0],
    ]
    const hull = OsmExtent.convexHull(c)
    expect(OsmExtent.containsAll(hull, c)).toBe(true)
    expect(hull.some(([x, y]) => x === 2 && y === 1)).toBe(false)
    expect(OsmExtent.containsAll(hull, [[2, 1]])).toBe(true)
  })

  test("too many parts fall back to one box over all of them", () => {
    const many = Array.from({ length: 12 }, (_, i) => [square(114 + i, 30, 0.1)])
    const resolved = OsmExtent.parse("file:/b.geojson", () => asFile({ type: "MultiPolygon", coordinates: many }))
    expect(resolved.exact).toBe(false)
    expect(resolved.spatial.filters).toHaveLength(1)
    expect(resolved.spatial.filters[0]).toBe("(29.9,113.9,30.1,125.1)")
  })

  test("a file in the wrong reference system is refused, not reprojected", () => {
    const utm = [
      [500000, 3320000],
      [510000, 3320000],
      [510000, 3330000],
      [500000, 3330000],
      [500000, 3320000],
    ]
    expect(() => OsmExtent.parse("file:/b.geojson", () => asFile({ type: "Polygon", coordinates: [utm] }))).toThrow(
      /EPSG:4326/,
    )
  })

  test("unreadable, unparsable and geometry-free files each say what is wrong", () => {
    expect(() =>
      OsmExtent.parse("file:/b.shp", () => {
        throw new Error("nope")
      }),
    ).toThrow(/GeoJSON/)
    expect(() =>
      OsmExtent.parse("file:/b.geojson", () => {
        throw new Error("nope")
      }),
    ).toThrow(/could not be read/)
    expect(() => OsmExtent.parse("file:/b.geojson", () => "{not json")).toThrow(/not valid JSON/)
    expect(() =>
      OsmExtent.parse("file:/b.geojson", () =>
        asFile({
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        }),
      ),
    ).toThrow(/no Polygon/)
  })

  test("a byte-order mark does not make a file unreadable", () => {
    const resolved = OsmExtent.parse(
      "file:/b.geojson",
      () => "\uFEFF" + asFile({ type: "Polygon", coordinates: [square(114, 30, 0.1)] }),
    )
    expect(resolved.exact).toBe(true)
  })
})
