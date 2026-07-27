import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MachineConfig } from "@/geo/config"
import { GeoStatus } from "@/geo/status"
import { RootHttpApi } from "../api"

/* --- GeoCode: handlers for the data face (docs/GEOKERNEL.md §10.1 #3). --- */

export const GeoHandler = HttpApiBuilder.group(RootHttpApi, "geo", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const status = yield* GeoStatus.Service
        return yield* status.snapshot()
      }),
    )
    .handle("reload", () =>
      Effect.gen(function* () {
        const config = yield* MachineConfig.Service
        yield* config.reload()
        return { reloaded: true as const }
      }),
    ),
)
