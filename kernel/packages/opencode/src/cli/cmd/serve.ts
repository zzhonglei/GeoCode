import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
// GeoCode: the synchronous sweep this process owes its children (docs/GEOKERNEL.md §10.1 #8b).
import { GeoRuntime } from "@/geo/runtime"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    /* --- GeoCode: take the geographic processes down with us (docs/GEOKERNEL.md §10.1 #8b).
     *
     * This is the process the desktop shell spawns and the process it signals
     * on quit. Node's default handling of SIGTERM and SIGINT terminates without
     * running any `exit` listener, so the Runtime module's last line of defence
     * never fires — and a QGIS algorithm mid-run is orphaned, holding CPU and
     * memory that the user can no longer see or stop (§3.2, process drift).
     *
     * Synchronous by necessity: nothing asynchronous can be relied on to finish
     * once a termination signal has arrived. Handling the signal here rather
     * than inside Runtime is deliberate — deciding how the application shuts
     * down belongs to whoever owns the process, not to a module that happens to
     * spawn children (§3.2).
     *
     * The shell has the mirror-image obligation: kill the process TREE, not
     * just this process, or the sweep never gets the chance to run. --- */
    const runtime = yield* GeoRuntime.Service
    const teardown = () => {
      runtime.killAllSync()
      process.exit()
    }
    process.once("SIGTERM", teardown)
    process.once("SIGINT", teardown)

    yield* Effect.never
  }),
})
