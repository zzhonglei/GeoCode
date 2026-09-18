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
import { InstanceStore } from "@/project/instance-store"
import { ServerAuth } from "@/server/auth"
import { MachineConfig } from "@/geo/config"
import { GeoStatus } from "@/geo/status"
import { RootHttpApi } from "@/server/routes/instance/httpapi/api"
import { GlobalPaths } from "@/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "@/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "@/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "@/server/routes/instance/httpapi/handlers/global"
import { GeoHandler } from "@/server/routes/instance/httpapi/handlers/geo"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "./lib/effect"

/* GeoCode: the global config layer caches forever, so a dispose that does not drop it first rebuilds the instances
 * on the config from before the shell edited the file (docs/DESKTOP.md §5.2). */

const calls: string[] = []

const geoLayer = LayerNode.compile(LayerNode.group([GeoStatus.node, MachineConfig.node]))

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
  Layer.provide(
    Layer.mock(Config.Service)({
      invalidate: () => Effect.sync(() => void calls.push("invalidate")),
    }),
  ),
  Layer.provide(
    Layer.mock(InstanceStore.Service)({
      disposeAll: () => Effect.sync(() => void calls.push("disposeAll")),
    }),
  ),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)

const it = testEffect(apiLayer)

describe("GeoCode: global dispose", () => {
  it.live("drops the global config layer before disposing the instances", () =>
    Effect.gen(function* () {
      calls.length = 0
      const response = yield* HttpClient.post(GlobalPaths.dispose)
      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
      expect(calls).toEqual(["invalidate", "disposeAll"])
    }),
  )
})
