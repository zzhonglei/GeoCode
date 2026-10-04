import { Cause, Effect, Exit, Layer } from "effect"
import { Config } from "./config.ts"
import { Engine } from "./engine.ts"
import { Qgis } from "./qgis/index.ts"
import { Runtime } from "./runtime.ts"
import { Status } from "./status.ts"
import { Transport } from "./transport.ts"

// An argument, not an environment variable, which every task process would inherit.
const machine = process.argv.find((arg) => arg.startsWith("--machine="))?.slice("--machine=".length)
if (!machine) throw new Error("GeoEngine needs --machine=<path to machine.json>")

const transport = Transport.parentPort()

const layer = Layer.mergeAll(Runtime.layer(Engine.ledger(transport)), Status.layer, Config.layer(machine))

const fiber = Effect.runFork(Effect.scoped(Engine.run(transport, [Qgis.capability])).pipe(Effect.provide(layer)))

// Exiting is what lets the main process notice: a utility process stays alive with nothing left to do.
fiber.addObserver((exit) => {
  if (Exit.isFailure(exit)) console.error(Cause.pretty(exit.cause))
  process.exit(1)
})
