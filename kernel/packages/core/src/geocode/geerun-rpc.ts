export * as GeeRunRpc from "./geerun-rpc.js"

import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"
import { Bus } from "../bus.js"

/** A run under way in the background, as the interface shows it beside the commands running there. */
export const Run = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  description: Schema.String,
  startedAt: Schema.Number,
})

/**
 * Every run under way in the background. A later list has a higher revision: one more than the last, or the time if
 * that is higher, so a list after a restart is later too.
 */
export const Snapshot = Schema.Struct({ revision: Schema.Number, runs: Schema.Array(Run) })

export const Definition = Rpc.define({
  id: "geocode.geeruns",
  methods: {
    list: { input: Schema.Struct({}), output: Snapshot },
    stop: { input: Schema.Struct({ id: Schema.String }), output: Schema.Void },
  },
  events: { changed: { schema: Snapshot } },
})

/**
 * The event `changed` stands for, published by the app's GeeRunJob rather than through the plugin, whose location
 * may be evicted while a run goes on. The event stream passes it on as it passes on every `rpc.` event.
 */
export const Changed = Bus.ephemeral({ type: "rpc.geocode.geeruns.changed", schema: Snapshot.fields })
