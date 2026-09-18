import { describe, expect, test } from "bun:test"
import { Context } from "effect"
import { GeoPaths } from "@/server/routes/instance/httpapi/groups/geo"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"

/* The geo routes, reached the way a client reaches them (docs/GEOKERNEL.md §10.1 #4). */

const context = Context.empty() as Context.Context<unknown>

describe("geo routes reach the kernel", () => {
  test("the status face answers through the assembled application", async () => {
    // Deliberately overlaps status-endpoint.test.ts, whose hand-built layer stack stays green when the server
    // cannot reach the node and every geo route answers 500.
    const response = await HttpApiApp.webHandler().handler(
      new Request(new URL(`http://localhost${GeoPaths.status}`)),
      context,
    )
    expect(response.status).toBe(200)
  })
})
