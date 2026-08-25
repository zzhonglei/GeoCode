import { describe, expect, test } from "bun:test"
import { Context } from "effect"
import { GeoPaths } from "@/server/routes/instance/httpapi/groups/geo"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"

/* The geo routes, reached the way a client reaches them (docs/GEOKERNEL.md §10.1 #4). */

const context = Context.empty() as Context.Context<unknown>

describe("geo routes reach the kernel", () => {
  test("the status face answers through the assembled application", async () => {
    // Deliberately overlaps status-endpoint.test.ts, which hand-builds its own layer stack and so
    // says nothing about whether the SERVER can reach the node — it could not once, and every geo
    // route answered 500 with that test still green.
    const response = await HttpApiApp.webHandler().handler(
      new Request(new URL(`http://localhost${GeoPaths.status}`)),
      context,
    )
    expect(response.status).toBe(200)
  })
})
