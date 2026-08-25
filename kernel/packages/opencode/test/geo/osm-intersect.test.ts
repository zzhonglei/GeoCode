import { describe, expect, test } from "bun:test"
import { OsmIntersect } from "@/geo/osm/intersect"

/* Replaying the boundary test Overpass could not run (docs/GEOKERNEL.md §6.4), on coordinates simple enough to
 * check by hand. */

type Point = OsmIntersect.Point

/** The 10×10 square with its lower-left corner at the origin. */
const SQUARE: OsmIntersect.Polygon = {
  outer: [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ],
  holes: [],
}

/** The same square with a 2×2 hole punched out of the middle. */
const HOLED: OsmIntersect.Polygon = {
  outer: SQUARE.outer,
  holes: [
    [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ],
  ],
}

const geo = (type: string, coordinates: unknown) => ({ type, coordinates })

describe("a point against a boundary", () => {
  const idx = OsmIntersect.index([SQUARE])

  test("inside", () => expect(OsmIntersect.contains(idx, [5, 5])).toBe(true))
  test("outside", () => expect(OsmIntersect.contains(idx, [15, 5])).toBe(false))

  test("a hole is not inside, however far inside the outer ring it sits", () => {
    const holed = OsmIntersect.index([HOLED])
    expect(OsmIntersect.contains(holed, [5, 5])).toBe(false)
    expect(OsmIntersect.contains(holed, [2, 2])).toBe(true)
  })

  test("a vertex lying exactly on the ray is counted once, not twice", () => {
    expect(OsmIntersect.contains(idx, [5, 10 - 1e-9])).toBe(true)
  })
})

describe("two segments", () => {
  const cross = OsmIntersect.segmentsCross

  test("crossing", () => expect(cross([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true))
  test("apart", () => expect(cross([0, 0], [1, 1], [5, 5], [6, 6])).toBe(false))
  test("touching at an endpoint", () => expect(cross([0, 0], [5, 5], [5, 5], [9, 1])).toBe(true))

  test("collinear and overlapping", () => {
    expect(cross([0, 0], [10, 0], [2, 0], [8, 0])).toBe(true)
  })

  test("collinear and disjoint", () => expect(cross([0, 0], [4, 0], [6, 0], [10, 0])).toBe(false))
})

describe("a feature against a boundary", () => {
  const idx = OsmIntersect.index([SQUARE])
  const hits = (geometry: unknown) => OsmIntersect.intersects(geometry, idx)

  test("a point inside, a point outside", () => {
    expect(hits(geo("Point", [5, 5]))).toBe(true)
    expect(hits(geo("Point", [50, 50]))).toBe(false)
  })

  test("a road crossing the boundary with BOTH ends outside it", () => {
    expect(
      hits(
        geo("LineString", [
          [-5, 5],
          [15, 5],
        ]),
      ),
    ).toBe(true)
  })

  test("a road that misses entirely", () => {
    expect(
      hits(
        geo("LineString", [
          [-5, 20],
          [15, 20],
        ]),
      ),
    ).toBe(false)
  })

  test("a road with one end inside is kept WHOLE — nothing is cut", () => {
    const road = geo("LineString", [
      [5, 5],
      [50, 5],
    ])
    expect(hits(road)).toBe(true)
    expect(road.coordinates).toEqual([
      [5, 5],
      [50, 5],
    ])
  })

  test("a polygon that CONTAINS the whole study area", () => {
    expect(
      hits(
        geo("Polygon", [
          [
            [-100, -100],
            [100, -100],
            [100, 100],
            [-100, 100],
            [-100, -100],
          ],
        ]),
      ),
    ).toBe(true)
  })

  test("multi-geometries answer if any part does", () => {
    expect(
      hits(
        geo("MultiPoint", [
          [50, 50],
          [5, 5],
        ]),
      ),
    ).toBe(true)
    expect(
      hits(
        geo("MultiPoint", [
          [50, 50],
          [60, 60],
        ]),
      ),
    ).toBe(false)
    expect(hits({ type: "GeometryCollection", geometries: [geo("Point", [5, 5])] })).toBe(true)
  })
})

describe("what it does when it cannot tell", () => {
  const idx = OsmIntersect.index([SQUARE])

  // Keeping one feature too many costs a row; dropping one costs a fact nobody can see is absent (§6.4).
  test("an unreadable geometry is KEPT", () => {
    expect(OsmIntersect.intersects({ type: "Sphere", coordinates: [0, 0] }, idx)).toBe(true)
    expect(OsmIntersect.intersects(undefined, idx)).toBe(true)
    expect(OsmIntersect.intersects({ type: "Point", coordinates: "nonsense" }, idx)).toBe(true)
    expect(OsmIntersect.intersects(geo("LineString", []), idx)).toBe(true)
  })
})

describe("the grid is an optimisation, never an answer", () => {
  // Big enough that the index actually buckets, checked against the exhaustive loop it is a faster route to.
  const ring: Point[] = []
  for (let i = 0; i < 400; i++) {
    const t = (i / 400) * Math.PI * 2
    ring.push([50 + 40 * Math.cos(t), 50 + 40 * Math.sin(t)])
  }
  ring.push(ring[0]!)
  const circle: OsmIntersect.Polygon = { outer: ring, holes: [] }
  const idx = OsmIntersect.index([circle])

  const naive = (a: Point, b: Point) => {
    for (let i = 0; i + 1 < ring.length; i++) {
      if (OsmIntersect.segmentsCross(a, b, ring[i]!, ring[i + 1]!)) return true
    }
    return false
  }

  test("indexed crossing agrees with exhaustive crossing, everywhere", () => {
    let checked = 0
    for (let x = -10; x <= 110; x += 7) {
      for (let y = -10; y <= 110; y += 11) {
        const a: Point = [x, y]
        const b: Point = [x + 23, y + 17]
        expect(OsmIntersect.crosses(idx, a, b)).toBe(naive(a, b))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(150)
  })
})

describe("the equivalence the whole design rests on", () => {
  // A boundary too detailed to send is queried by its hull and narrowed back here; the answer has to match what a
  // server filtering by the real boundary would have returned.
  const star: Point[] = []
  for (let i = 0; i < 24; i++) {
    const t = (i / 24) * Math.PI * 2
    const r = i % 2 === 0 ? 40 : 12 // deep concavities: hull ≫ boundary
    star.push([50 + r * Math.cos(t), 50 + r * Math.sin(t)])
  }
  star.push(star[0]!)
  const boundary: OsmIntersect.Polygon = { outer: star, holes: [] }
  const idx = OsmIntersect.index([boundary])

  test("filtering by the real boundary keeps exactly the features inside it", () => {
    let insideCount = 0
    for (let x = 0; x <= 100; x += 3) {
      for (let y = 0; y <= 100; y += 3) {
        const truth = OsmIntersect.inPolygon([x, y], boundary)
        expect(OsmIntersect.intersects(geo("Point", [x, y]), idx)).toBe(truth)
        if (truth) insideCount++
      }
    }
    // Both answers have to occur, or a constant `intersects` would pass the loop above.
    expect(insideCount).toBeGreaterThan(50)
    expect(insideCount).toBeLessThan(34 * 34)
  })
})
