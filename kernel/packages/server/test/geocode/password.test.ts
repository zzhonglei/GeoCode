import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpServer } from "effect/http"
import { it } from "../../../core/test/lib/effect"
import { ServerProcess } from "../../src/process"

// Guards against a pairing link or a ticket (a terminal's, an MCP client's) letting a request into the kernel
// without its password.
it.live("GeoCode: pairing links and tickets need the password", () =>
  Effect.gen(function* () {
    const server = yield* ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test-version" },
      database: { path: ":memory:" },
    })
    const base = HttpServer.formatAddress(server.address)
    const request = (pathname: string, init?: RequestInit) =>
      Effect.promise(() => fetch(new URL(pathname, base), { redirect: "manual", ...init }))

    const issued = yield* request("/api/pair", {
      method: "POST",
      headers: { authorization: `Basic ${btoa("opencode:secret")}` },
    })
    expect(issued.status).toBe(200)
    const pairing = (yield* Effect.promise(() => issued.json())) as { code: string }

    // Upstream refuses the made-up ticket with 403 too, so only a 401 shows the password was asked for.
    for (const pathname of [
      `/auth/connect/${pairing.code}`,
      "/api/pty/pty_1/connect?ticket=t",
      "/api/experimental/persistent-pty/pty_1/connect?ticket=t",
      "/api/experimental/client-mcp?name=m&ticket=t",
    ]) {
      expect((yield* request(pathname)).status).toBe(401)
    }
  }),
)
