export * as QgisCatalog from "./catalog"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import type { Environment } from "./types"

/* --- GeoCode: the algorithm catalog's seam (docs/GEOKERNEL.md §4.11).
 *
 * The lifecycle drives WHEN a catalog is built and voided; this service owns
 * HOW, and holds the result in memory. Split as a service so the lifecycle's
 * stage semantics — one token across both stages, a new round voiding the
 * build in flight — can be exercised against a scripted builder, and so the
 * real exporter can land as a pure swap of this layer. --- */

export type BuildOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string }

export interface Interface {
  /**
   * Export the catalog for a verified environment and keep it in memory.
   *
   * Runs in the round fiber, under the round's token: a new round interrupts
   * the build (阶段依附, §4.8) and Status discards any late commit (代际).
   */
  readonly build: (environment: Environment) => Effect.Effect<BuildOutcome>
  /**
   * Drop whatever is held. Called at the start of every round: the catalog
   * belongs to the environment verification that produced it, and a new
   * round means that verification is being redone (§4.8).
   */
  readonly invalidate: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/QgisCatalog") {}

/**
 * Placeholder until the real exporter lands (2c). Honest by design: it FAILS
 * the catalog stage rather than pretending an empty catalog is a built one —
 * the unified gate stays shut (§4.9), which is the truth, instead of opening
 * onto capabilities whose retrieval would return nothing.
 */
const stub = Layer.succeed(
  Service,
  Service.of({
    build: () => Effect.succeed({ ok: false as const, error: "algorithm catalog is not implemented yet" }),
    invalidate: () => Effect.void,
  }),
)

export const node = makeGlobalNode({ service: Service, layer: stub, deps: [] })
