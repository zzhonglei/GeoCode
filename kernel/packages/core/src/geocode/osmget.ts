export * as OsmGetTools from "./osmget.js"

import { ToolFailure } from "@opencode/ai"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import type { FileAccess } from "../file-access.js"
import type { Location } from "../location.js"
import type { Permission } from "../permission.js"
import { GeoEngine } from "./geoengine.js"
import { GeoOsm } from "./osm.js"
import OBJECTS from "./osmgetobjects.txt"
import FEATURES from "./osmgetfeatures.txt"
import { GeoRunActivity } from "./run-activity.js"

export const objectsName = "osmgetobjects"

export const featuresName = "osmgetfeatures"

export const ObjectsInput = Schema.Struct({
  ids: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(25)).annotate({
    description:
      'OSM ids found with osmsearch, such as ["R65066", "W427818536"]: R for a relation, W for a way, N for a node. At most 25',
  }),
  output: GeoOsm.Output,
  fields: Schema.optionalKey(GeoOsm.Fields),
  description: GeoOsm.Label,
})

export const FeaturesInput = Schema.Struct({
  area: GeoOsm.Area,
  tags: GeoOsm.Tags,
  geometry: Schema.optionalKey(Schema.Literals(["original", "point"])).annotate({
    description:
      '"original" (the default) keeps each feature as mapped; "point" makes each one a point on or inside it, and records whether it was mapped as a point, a line or an area in a column, original_geometry',
  }),
  fields: Schema.optionalKey(GeoOsm.Fields),
  output: GeoOsm.Output,
  description: GeoOsm.Label,
})

interface Download {
  readonly tool: string
  readonly action: "objects" | "features"
  readonly label: string
  readonly output: FileAccess.Target
  /** GeoEngine's params, with every path absolute. */
  readonly params: object
  /** What is downloaded, as GeoAgent wrote it, for the answer to name. */
  readonly what: string
}

/**
 * Asks about a download once GeoEngine finds it could start, and has GeoEngine run it, the tool row told how it goes
 * and how it ended. A download outside the project is asked about on its own card, never apart as write asks about
 * the directory: even where the rules allow the tool, unless that directory was always allowed (GeoGuards).
 */
const run = <E>(
  prepared: Effect.Effect<Download, E>,
  permission: Permission.Interface,
  location: Location.Interface,
  context: Tool.Context,
) =>
  Effect.gen(function* () {
    const download = yield* prepared
    yield* GeoOsm.check(download.action, download.params).pipe(Effect.catch(GeoOsm.failed(download.tool, context)))
    const outside = download.output.externalDirectory
    // The directory the card names, not the repository it is in, which other tools save.
    const guards = outside ? [outside.resource] : []
    yield* permission.assert({
      action: download.tool,
      resources: outside ? guards : ["*"],
      save: outside ? guards : ["*"],
      metadata: {
        ...download.params,
        description: download.label,
        external: outside ? [outside.directory] : [],
        guards,
      },
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
    // Allowed and about to run: the location is not idle until the download ends.
    yield* GeoRunActivity.hold(location)
    const watched = GeoOsm.watch(context, download.label)
    const failed = GeoOsm.failed(download.tool, context, watched.ended)
    yield* context.progress(watched.state())
    const result = yield* GeoEngine.call(`osm.${download.action}`, download.params, watched.heed).pipe(
      Effect.catch(failed),
    )
    const answer = yield* GeoOsm.downloadAnswer(result, location.directory, download.what).pipe(Effect.catch(failed))
    return { content: answer.content, metadata: { ...watched.ended(), result: answer.shown } }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof ToolFailure
        ? error
        : new ToolFailure({ message: "Unable to download from OpenStreetMap", error }),
    ),
  )

export const makeObjects = (
  permission: Permission.Interface,
  access: FileAccess.Interface,
  location: Location.Interface,
) => ({
  name: objectsName,
  // On the provider's tool list, as the built-in tools are, rather than inside Code Mode's catalog.
  options: { codemode: false },
  description: OBJECTS,
  input: ObjectsInput,
  execute: (input: typeof ObjectsInput.Type, context: Tool.Context) =>
    run(
      Effect.gen(function* () {
        const output = yield* access.resolve({ path: input.output, kind: "file" })
        const params = { ids: input.ids, output: output.absolute, ...(input.fields ? { fields: input.fields } : {}) }
        const what = `the OSM objects ${input.ids.join(", ")}`
        return { tool: objectsName, action: "objects", label: input.description, output, params, what } as const
      }),
      permission,
      location,
      context,
    ),
})

export const makeFeatures = (
  permission: Permission.Interface,
  access: FileAccess.Interface,
  location: Location.Interface,
) => ({
  name: featuresName,
  // On the provider's tool list, as the built-in tools are, rather than inside Code Mode's catalog.
  options: { codemode: false },
  description: FEATURES,
  input: FeaturesInput,
  execute: (input: typeof FeaturesInput.Type, context: Tool.Context) =>
    run(
      Effect.gen(function* () {
        const output = yield* access.resolve({ path: input.output, kind: "file" })
        const area = yield* GeoOsm.resolveArea(access, input.area)
        const params = {
          area,
          tags: input.tags,
          output: output.absolute,
          ...(input.geometry ? { geometry: input.geometry } : {}),
          ...(input.fields ? { fields: input.fields } : {}),
        }
        const what = `${input.tags.join(", ")} in ${input.area}`
        return { tool: featuresName, action: "features", label: input.description, output, params, what } as const
      }),
      permission,
      location,
      context,
    ),
})
