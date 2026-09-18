import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "../src/agent/agent"
import { GeoKernel, GeoQgis, GeoStatus } from "../src/geo"
import { QgisCatalog } from "../src/geo/qgis/catalog"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import { docsUrl, formatAlgorithm } from "../src/tool/geo-qgis-doc"
import DOC_DESCRIPTION from "../src/tool/geo-qgis-doc.txt"
import READ_DESCRIPTION from "../src/tool/geo-read.txt"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"
import { QGIS_READY, statusHolding } from "./lib/geocode-status"

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

/** Enforced rather than assumed: other files in this process drive the same kernel with real machine.json hints. */
const forceUnconfigured = Effect.fnUntraced(function* () {
  fs.rmSync(path.join(Global.Path.config, "machine.json"), { force: true })
  const qgis = yield* GeoQgis.Service
  const deadline = Date.now() + 10_000
  let gate = yield* qgis.gate()
  while ((gate.ok || gate.status.status !== "unconfigured") && Date.now() < deadline) {
    yield* Effect.sleep(200)
    gate = yield* qgis.gate()
  }
  expect(!gate.ok && gate.status.status === "unconfigured").toBe(true)
})

const executeAs = Effect.fnUntraced(function* (agentName: string, params: Record<string, unknown>) {
  const registry = yield* ToolRegistry.Service
  const permission = yield* Permission.Service
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  expect(agent).toBeDefined()
  const qgisdoc = (yield* registry.all()).find((tool) => tool.id === "QgisDoc")
  expect(qgisdoc).toBeDefined()

  return yield* qgisdoc!
    .execute(params, {
      sessionID: SessionID.make("ses_qgis_doc_test"),
      messageID: MessageID.make("msg_qgis_doc_test"),
      agent: agentName,
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) =>
        permission
          .ask({ ...req, sessionID: SessionID.make("ses_qgis_doc_test"), ruleset: agent!.permission })
          .pipe(Effect.orDie),
    })
    .pipe(Effect.timeout(5_000), Effect.exit)
})

describe("QgisDoc", () => {
  it.instance("is in the registry", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("QgisDoc")
    }),
  )

  it.instance(
    "looking things up never interrupts, in plan mode least of all",
    () =>
      Effect.gen(function* () {
        yield* forceUnconfigured()

        // Reading the config cannot tell a grant that matched from one that was written and silently missed.
        const allowed = yield* executeAs("GeoAgent", { action: "list_groups" })
        expect(Exit.isSuccess(allowed)).toBe(true)

        // A pattern that stopped matching plan's "doc:*" would fall to the ask and hang on a user who is not there.
        const planned = yield* executeAs("plan", { action: "list_groups" })
        expect(Exit.isSuccess(planned)).toBe(true)
      }),
    { timeout: 30_000 },
  )

  const itReady = testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoStatus.node, statusHolding({ qgis: QGIS_READY })],
    ]),
  )

  itReady.instance(
    "approving a documentation lookup grants documentation, and nothing else",
    () =>
      Effect.gen(function* () {
        const seen: { patterns: readonly string[]; always: readonly string[] }[] = []

        const registry = yield* ToolRegistry.Service
        const qgisdoc = (yield* registry.all()).find((tool) => tool.id === "QgisDoc")
        yield* qgisdoc!.execute({ action: "read", algorithm: "native:buffer" }, {
          sessionID: SessionID.make("ses_always"),
          messageID: MessageID.make("msg_always"),
          agent: "GeoAgent",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: (req: any) => {
            seen.push({ patterns: req.patterns, always: req.always })
            return Effect.void
          },
        } as any)

        expect(seen).toHaveLength(1)
        // The namespace, so a rule can tell this apart from running something.
        expect(seen[0]!.patterns).toEqual(["doc:read:native:buffer"])
        // The qgis key is shared with RunQgisAlgorithm, so always: ["*"] would turn one approved lookup into a
        // standing grant to run algorithms.
        expect(seen[0]!.always).toEqual(["doc:*"])
        expect(seen[0]!.always).not.toContain("*")
      }),
    { timeout: 30_000 },
  )

  it.instance(
    "an unconfigured environment answers with the kernel's guidance",
    () =>
      Effect.gen(function* () {
        // Without the gate the empty-catalog branch tells the model to call again instead of naming the file to write.
        yield* forceUnconfigured()

        const result = yield* executeAs("GeoAgent", { action: "list_groups" })
        expect(Exit.isSuccess(result)).toBe(true)
        if (Exit.isSuccess(result)) {
          expect(result.value.metadata.error).toBe(true)
          expect(result.value.metadata.geoStatus).toBe("unconfigured")
          expect(result.value.output).toContain(path.join(Global.Path.config, "machine.json"))
        }
      }),
    { timeout: 30_000 },
  )

  test("the doc anchor comes from the display name, not the algorithm id", () => {
    const url = docsUrl({ id: "native:reclassifybytable", name: "Reclassify by table", group: "Raster analysis" })
    expect(url).toBe(
      "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs/qgis/rasteranalysis.html#reclassify-by-table",
    )
    expect(url).not.toContain("#reclassifybytable")

    expect(
      docsUrl({ id: "gdal:cliprasterbymasklayer", name: "Clip raster by mask layer", group: "Raster extraction" }),
    ).toBe(
      "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs/gdal/rasterextraction.html#clip-raster-by-mask-layer",
    )
    expect(docsUrl({ id: "native:x", name: "Split & merge", group: "Vector general" })).toContain("#split-merge")

    // Without a group, the index rather than ".../qgis/.html#name", which is a 404.
    expect(docsUrl({ id: "native:orphan", name: "Orphan", group: "" })).toBe(
      "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs/index.html",
    )

    expect(docsUrl({ id: "qgis:buffer", name: "Buffer", group: "Vector geometry" })).toContain("/qgis/")
    expect(docsUrl({ id: "gdal:buffer", name: "Buffer", group: "Vector geometry" })).toContain("/gdal/")
    expect(docsUrl({ id: "grass7:v.buffer", name: "Buffer", group: "Vector" })).toBe(
      "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs/index.html",
    )
  })

  test("QGIS help text is reproduced verbatim, and only replaced when absent", () => {
    const param = {
      name: "DISTANCE",
      description: "Buffer distance",
      type: "distance",
      defaultValue: "10",
      options: [] as string[],
      optional: false,
    }
    // Blank lines, indentation and a trailing space, exactly what a tidy-up would normalise.
    const helpText = [
      "<b>Buffer</b>  distance",
      "",
      "    Accepted data types:",
      "        - numeric ",
      "",
      "See also: native:multiringconstantbuffer",
    ].join("\n")

    const withHelp = formatAlgorithm({
      id: "native:buffer",
      name: "Buffer",
      group: "Vector geometry",
      description: "A description the raw help already covers.",
      helpText,
      parameters: [param],
      outputs: [{ name: "OUTPUT", description: "Buffered", type: "sink" }],
    })
    expect(withHelp).toContain(helpText)
    expect(withHelp).toContain("Required: DISTANCE")
    expect(withHelp).toContain("  DISTANCE: 10")
    // No second rendering of what the help already says, or the model reads every parameter twice.
    expect(withHelp).not.toContain("Parameters from QGIS API:")
    expect(withHelp).not.toContain("Outputs from QGIS API:")
    expect(withHelp).not.toContain("A description the raw help already covers.")

    const withoutHelp = formatAlgorithm({
      id: "plugin:thing",
      name: "Thing",
      group: "Plugins",
      description: "What the plugin does.",
      helpText: "",
      parameters: [{ ...param, options: ["first", "second"] }],
      outputs: [{ name: "OUTPUT", description: "Result", type: "sink" }],
    })
    expect(withoutHelp).toContain("Parameters from QGIS API:")
    expect(withoutHelp).toContain("    0: first")
    expect(withoutHelp).toContain("Outputs from QGIS API:")
    expect(withoutHelp).toContain("What the plugin does.")

    for (const rendered of [withHelp, withoutHelp]) {
      expect(rendered).toContain("**External verification:**")
      expect(rendered).toContain("Algorithm ID: ")
    }

    // Under the name groups() lists it by, the one list_algorithms answers to; the raw empty string is not.
    const orphan = formatAlgorithm({
      id: "native:orphan",
      name: "Orphan",
      group: "",
      description: "Belongs nowhere.",
      helpText: "orphan help",
      parameters: [],
      outputs: [],
    })
    expect(orphan).toContain(`Group: ${QgisCatalog.UNGROUPED}`)
    expect(orphan).not.toContain("Group: \n")
  })

  test("the QGIS group speaks with one voice about its environment", () => {
    // Both tools return the same kernel-authored guidance, and an edit to one description leaves the other stale.
    const shared =
      "This tool needs the user's QGIS environment. When that environment is not ready, the output says exactly what is missing and who can fix it — relay that to the user instead of retrying."
    expect(READ_DESCRIPTION).toContain(shared)
    expect(DOC_DESCRIPTION).toContain(shared)

    // Lookup folds case and separators, so demanding an exact group name talks the model out of a working call.
    expect(DOC_DESCRIPTION).not.toContain("exact group name")
    expect(DOC_DESCRIPTION).toContain("Prefer the full algorithm ID")
  })
})

describe("QgisDoc, gate open", () => {
  const algorithm = (id: string, name: string, group: string, description = ""): QgisCatalog.Algorithm => ({
    id,
    name,
    group,
    description,
    helpText: "help",
    parameters: [],
    outputs: [],
  })

  const ALGORITHMS = [
    algorithm("native:buffer", "Buffer", "Vector geometry", "Computes a buffer."),
    algorithm("gdal:warpreproject", "Warp (reproject)", "Vector geometry"),
    algorithm("gdal:orphan", "Orphan", ""),
    ...Array.from({ length: 12 }, (_, index) => algorithm(`native:many${index}`, `Many ${index}`, "Crowded")),
  ]

  const openGate = Layer.succeed(
    GeoQgis.Service,
    GeoQgis.Service.of({
      gate: () =>
        Effect.succeed({
          ok: true,
          environment: {
            python: "/fake/python3.12",
            prefix: "/fake/prefix",
            env: {},
            dllDirectories: [],
            versions: { python: "3.12.11", gdal: "3.12.0", qgis: "3.44.9" },
            processing: true,
          },
        }),
    }),
  )

  /** The real tiering is the catalog's own tripwire; this only has to reach all three outcomes. */
  const resolveStub = (id: string): QgisCatalog.Resolution => {
    if (id === "Slope") return { kind: "ambiguous", candidates: ["gdal:slope", "native:slope"] }
    const found = ALGORITHMS.find((item) => item.id === id)
    return found ? { kind: "found", algorithm: found } : { kind: "missing" }
  }

  const stubCatalog = Layer.succeed(
    QgisCatalog.Service,
    QgisCatalog.Service.of({
      resolve: (id) => Effect.succeed(resolveStub(id)),
      build: () => Effect.succeed({ ok: true as const }),
      invalidate: () => Effect.void,
      groups: () =>
        Effect.succeed([
          { name: "Crowded", count: 12 },
          { name: "Vector geometry", count: 2 },
          { name: QgisCatalog.UNGROUPED, count: 1 },
        ]),
      inGroup: (group) =>
        Effect.succeed(
          ALGORITHMS.filter(
            (item) =>
              (item.group || QgisCatalog.UNGROUPED).toLowerCase().replace(/[^a-z0-9]/g, "") ===
              group.toLowerCase().replace(/[^a-z0-9]/g, ""),
          ),
        ),
      get: (id) => {
        const outcome = resolveStub(id)
        return Effect.succeed(outcome.kind === "found" ? outcome.algorithm : undefined)
      },
      search: (query, limit = 10) =>
        Effect.succeed(
          ALGORITHMS.filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(query.toLowerCase())).slice(
            0,
            limit,
          ),
        ),
      suggest: () => Effect.succeed(["native:buffer", "gdal:warpreproject"]),
    }),
  )

  const it = testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoQgis.node, openGate],
      [QgisCatalog.node, stubCatalog],
    ]),
  )

  const run = Effect.fnUntraced(function* (params: Record<string, unknown>) {
    const result = yield* executeAs("GeoAgent", params)
    expect(Exit.isSuccess(result)).toBe(true)
    if (!Exit.isSuccess(result)) throw new Error("refused")
    return result.value
  })

  it.instance("a resolved group is reported by the name the catalog holds", () =>
    Effect.gen(function* () {
      const listed = yield* run({ action: "list_algorithms", group: "VECTOR GEOMETRY" })
      expect(listed.metadata.group).toBe("Vector geometry")
      expect(listed.title).toContain("Vector geometry")
      expect(listed.metadata.count).toBe(2)

      const orphans = yield* run({ action: "list_algorithms", group: "ungrouped" })
      expect(orphans.metadata.group).toBe(QgisCatalog.UNGROUPED)
    }),
  )

  it.instance("a bounded search says so in both channels", () =>
    Effect.gen(function* () {
      const many = yield* run({ action: "search", query: "many" })
      expect(many.metadata.count).toBe(10)
      expect(many.metadata.more).toBe(true)
      expect(many.output).toContain("Narrow the query")

      const few = yield* run({ action: "search", query: "buffer" })
      expect("more" in few.metadata).toBe(false)
      expect(few.output).not.toContain("Narrow the query")
    }),
  )

  it.instance("a miss answers with candidates instead of an error", () =>
    Effect.gen(function* () {
      const missed = yield* run({ action: "read", algorithm: "native:nosuchthing" })
      expect(missed.output).toContain("Did you mean: native:buffer, gdal:warpreproject?")
      expect(missed.metadata.truncated).toBe(false)

      // Ambiguity is not absence: "not found" would send the model searching for a name the catalog holds twice.
      const many = yield* run({ action: "read", algorithm: "Slope" })
      expect(many.output).toContain("names 2 algorithms")
      expect(many.output).toContain("gdal:slope, native:slope")
      expect(many.output).not.toContain("not found")
      expect(many.metadata.ambiguous).toBe(true)
      expect(many.metadata.candidates).toEqual(["gdal:slope", "native:slope"])

      const noGroup = yield* run({ action: "list_algorithms" })
      expect(noGroup.output).toContain('action="list_groups"')

      const noQuery = yield* run({ action: "search" })
      expect(noQuery.output).toContain('"query"')
    }),
  )
})
