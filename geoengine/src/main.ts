import path from "node:path"
import { Cause, Effect, Exit, Layer, Logger } from "effect"
import { Config } from "./config.ts"
import { Engine } from "./engine.ts"
import { Gee } from "./gee/index.ts"
import { Osm } from "./osm/index.ts"
import { Environment } from "./python/index.ts"
import { Qgis } from "./qgis/index.ts"
import { Runtime } from "./runtime.ts"
import { Status } from "./status.ts"
import { Transport } from "./transport.ts"

// Arguments, not environment variables, which every task process would inherit.
const argument = (name: string, what: string) => {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(`--${name}=`.length)
  if (!value) throw new Error(`GeoEngine needs --${name}=<${what}>`)
  return value
}
const machine = argument("machine", "path to machine.json")
const places = {
  bundle: argument("python", "folder of the bundled Python environment"),
  data: argument("data", "GeoCode's data directory"),
}
const locks = path.join(argument("state", "GeoCode's state directory"), "locks")

const transport = Transport.parentPort()

const layer = Layer.mergeAll(
  Runtime.layer(Engine.ledger(transport)),
  Status.layer,
  Config.layer(machine),
  // The main process writes the engine's stderr into the app's log; stdout reaches no one in a packaged app.
  Layer.succeed(Logger.LogToStderr, true),
)

const fiber = Effect.runFork(
  Effect.scoped(
    Engine.run(transport, [Environment.capability(places), Qgis.capability, Gee.capability, Osm.capability(locks)]),
  ).pipe(Effect.provide(layer)),
)

// Exiting is what lets the main process notice: a utility process stays alive with nothing left to do.
fiber.addObserver((exit) => {
  if (Exit.isFailure(exit)) console.error(Cause.pretty(exit.cause))
  process.exit(1)
})
