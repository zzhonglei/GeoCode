import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Installation } from "@/installation"
import { ServerAuth } from "@/server/auth"
import { GeoStatus } from "@/geo/status"
import { RootHttpApi } from "@/server/routes/instance/httpapi/api"
import { GeoPaths } from "@/server/routes/instance/httpapi/groups/geo"
import { controlHandlers } from "@/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "@/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "@/server/routes/instance/httpapi/handlers/global"
import { GeoHandler } from "@/server/routes/instance/httpapi/handlers/geo"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

/* The data face of GeoKernel, end to end (docs/GEOKERNEL.md §9.3, §10.1 #2-3).
 *
 * Uses the real Status service rather than a mock: the point is to prove the
 * route is mounted on the root api and reads the live slots, not that a stub
 * can return an object. */

const geoLayer = LayerNode.compile(LayerNode.group([GeoStatus.node]))

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, GeoHandler]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(geoLayer),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)

const it = testEffect(apiLayer)

describe("geo status endpoint", () => {
  it.live("reports a slot that has not registered as absent", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(GeoPaths.status)
      expect(response.status).toBe(200)
      // Honesty over optimism: a module that has not started has no status, and
      // the snapshot says so rather than inventing "unconfigured" on its behalf.
      expect(yield* response.json).toEqual({})
    }),
  )

  it.live("reports live slot values", () =>
    Effect.gen(function* () {
      const status = yield* GeoStatus.Service
      const writer = yield* status.register("gdal", { status: "unconfigured" })
      yield* writer.commit(yield* writer.claim(), { status: "raster-only", missing: ["ogr2ogr"] })

      const response = yield* HttpClient.get(GeoPaths.status)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ gdal: { status: "raster-only", missing: ["ogr2ogr"] } })
    }),
  )
})
