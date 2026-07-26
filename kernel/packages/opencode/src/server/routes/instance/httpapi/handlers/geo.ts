import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GeoStatus } from "@/geo/status"
import { RootHttpApi } from "../api"

/* --- GeoCode: handler for the data face (docs/GEOKERNEL.md §10.1 #3). --- */

export const GeoHandler = HttpApiBuilder.group(RootHttpApi, "geo", (handlers) =>
  handlers.handle("status", () =>
    Effect.gen(function* () {
      const status = yield* GeoStatus.Service
      return yield* status.snapshot()
    }),
  ),
)
