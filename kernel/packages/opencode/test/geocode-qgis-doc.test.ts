import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "../src/agent/agent"
import { GeoKernel, GeoQgis } from "../src/geo"
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

/* Tripwires for QgisDoc (docs/TOOLS.md §3; GEOKERNEL §4.11).
 *
 * The two pure tests are the important ones, and they are pure on purpose: the
 * doc-link rule and the verbatim-help rule were both calibrated against the
 * real world after the old version got them wrong, and both are the kind of
 * thing a later rewrite "tidies up" without noticing. Being pure, they run on
 * a machine with no QGIS installed — which is most machines a merge is
 * verified on.
 */

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

/**
 * Put the (process-global) kernel into `unconfigured` and wait for it.
 *
 * Every action of this tool goes through the readiness gate, so on a machine
 * that HAS QGIS the gate legitimately spends a cold start probing and building
 * the catalog — which would make these tests measure the local install rather
 * than what they are about. Forcing the environment out of the picture leaves
 * the ruleset as the only difference between two callers.
 *
 * The precondition is enforced, not assumed: other files in this process drive
 * the kernel with real machine.json hints, so relying on bun's file ordering
 * would make this hostage to a traversal detail. Idempotent — already
 * unconfigured means the loop never runs.
 */
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

/** The tool's real execute, run under a given agent's ruleset. */
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

  it.instance("the boundary holds: plan is refused, GeoAgent gets through", () =>
    Effect.gen(function* () {
      yield* forceUnconfigured()

      // The rule GeoAgent carries is the wildcard `geo_qgis_*`; the key this
      // tool asks with is `geo_qgis_doc`. Nothing but a behavioural test can
      // tell "the wildcard covers it" from "the wildcard silently misses it" —
      // the old version's exact accident (docs/KERNEL.md §4.1).
      const denied = yield* executeAs("plan", { action: "list_groups" })
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) {
        expect(Cause.pretty(denied.cause)).toContain("rule which prevents")
      }

      const allowed = yield* executeAs("GeoAgent", { action: "list_groups" })
      expect(Exit.isSuccess(allowed)).toBe(true)
    }),
    // forceUnconfigured() alone is allowed 10s, which already crosses bun's
    // 5s default — a gate that fails at random teaches people to re-run it
    // rather than read it.
    { timeout: 30_000 },
  )

  it.instance("an unconfigured environment answers with the kernel's guidance", () =>
    Effect.gen(function* () {
      // Without the gate this tool would answer an empty catalog as "no
      // algorithms" — a wrong answer rather than a visible failure.
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
    // The calibrated rule (GEOKERNEL §4.11): page name deletes non-alphanumerics
    // (no dashes), anchor collapses them to single dashes.
    const url = docsUrl({ id: "native:reclassifybytable", name: "Reclassify by table", group: "Raster analysis" })
    expect(url).toBe(
      "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs/qgis/rasteranalysis.html#reclassify-by-table",
    )
    // The old bug, stated as an assertion: an id-derived anchor has no dashes
    // and is a broken link for every multi-word name.
    expect(url).not.toContain("#reclassifybytable")

    // Ampersands are dropped outright, not turned into a dash run.
    expect(docsUrl({ id: "gdal:cliprasterbymasklayer", name: "Clip raster by mask layer", group: "Raster extraction" }))
      .toBe(
        "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs/gdal/rasterextraction.html#clip-raster-by-mask-layer",
      )
    expect(docsUrl({ id: "native:x", name: "Split & merge", group: "Vector general" })).toContain("#split-merge")

    // An algorithm with no group has no documentation page: link the index
    // rather than ".../qgis/.html#name", which is a 404 wearing a citation's
    // clothes.
    expect(docsUrl({ id: "native:orphan", name: "Orphan", group: "" })).toBe(
      "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs/index.html",
    )

    // Provider routing, including the fallback for anything not shipped by
    // the three official providers.
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
    // Deliberately awkward: blank lines, indentation, a trailing space, and
    // wording a "tidy-up" would normalise. Every byte must survive.
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
    // The two facts the help text cannot carry ride above it...
    expect(withHelp).toContain("Required: DISTANCE")
    expect(withHelp).toContain("  DISTANCE: 10")
    // ...and our own rendering of what the help ALREADY says does not, or the
    // Agent reads every parameter twice (the old version's regression).
    expect(withHelp).not.toContain("Parameters from QGIS API:")
    expect(withHelp).not.toContain("Outputs from QGIS API:")
    expect(withHelp).not.toContain("A description the raw help already covers.")

    // Empty help text is the only case the structured listing exists for.
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

    // Both paths end with the escape hatch to the official page.
    for (const rendered of [withHelp, withoutHelp]) {
      expect(rendered).toContain("**External verification:**")
      expect(rendered).toContain("Algorithm ID: ")
    }

    // A groupless algorithm is printed under the name groups() lists it by, so
    // the group the model reads here is one list_algorithms answers to. The
    // raw empty string would put an unusable value in front of it.
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
    // Both tools sit behind the same gate and hand back the same kernel-authored
    // guidance, so both descriptions have to prepare the Agent for it in the
    // same words. Pinned across the two files because the failure mode is
    // silent: one file gets edited, the other keeps the old promise, and the
    // Agent's behaviour depends on which tool it happened to call first.
    const shared =
      "This tool needs the user's QGIS environment. When that environment is not ready, the output says exactly what is missing and who can fix it — relay that to the user instead of retrying."
    expect(READ_DESCRIPTION).toContain(shared)
    expect(DOC_DESCRIPTION).toContain(shared)

    // The description must not promise an exactness the catalog no longer
    // demands, or the model will avoid a call that would have worked.
    expect(DOC_DESCRIPTION).not.toContain("exact group name")
    expect(DOC_DESCRIPTION).toContain("Prefer the full algorithm ID")
  })
})

/* The tool's own body, with the gate and the catalog stood in for.
 *
 * Everything above either avoids the gate or asserts what happens when it is
 * shut; this block is the other half — what the four actions actually render
 * once it opens. Standing in for both services is what makes that reachable on
 * a machine with no QGIS, which is most machines a merge is verified on, and
 * it is the same harness RunQgisAlgorithm's ten return paths will need.
 */
describe("QgisDoc, gate open", () => {
  const algorithm = (
    id: string,
    name: string,
    group: string,
    description = "",
  ): QgisCatalog.Algorithm => ({ id, name, group, description, helpText: "help", parameters: [], outputs: [] })

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

  /** The real tiering is the catalog's own tripwire; here it only has to be
   * able to produce all three outcomes so the tool's branches are reachable. */
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
          ALGORITHMS.filter((item) =>
            `${item.id} ${item.name}`.toLowerCase().includes(query.toLowerCase()),
          ).slice(0, limit),
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
      // Lookup tolerates case and separators (GEOKERNEL §4.11), so echoing the
      // caller's spelling would put "VECTOR GEOMETRY" in front of a user as if
      // that were the group's name. Title and metadata carry the catalog's.
      const listed = yield* run({ action: "list_algorithms", group: "VECTOR GEOMETRY" })
      expect(listed.metadata.group).toBe("Vector geometry")
      expect(listed.title).toContain("Vector geometry")
      expect(listed.metadata.count).toBe(2)

      // Same rule where the group is the stand-in name for having none.
      const orphans = yield* run({ action: "list_algorithms", group: "ungrouped" })
      expect(orphans.metadata.group).toBe(QgisCatalog.UNGROUPED)
    }),
  )

  it.instance("a bounded search says so in both channels", () =>
    Effect.gen(function* () {
      // The prose tells the model to narrow; the metadata has to agree, or a
      // frontend reading only fields renders "10 results" for a query with
      // more (the double-channel contract, GEOKERNEL §9.1).
      const many = yield* run({ action: "search", query: "many" })
      expect(many.metadata.count).toBe(10)
      expect(many.metadata.more).toBe(true)
      expect(many.output).toContain("Narrow the query")

      // ...and stays silent when there is nothing to warn about: `more` is a
      // flag, present only when true, never `more: false`.
      const few = yield* run({ action: "search", query: "buffer" })
      expect("more" in few.metadata).toBe(false)
      expect(few.output).not.toContain("Narrow the query")
    }),
  )

  it.instance("a miss answers with candidates instead of an error", () =>
    Effect.gen(function* () {
      // Every failure here is a documentation answer the model can act on, not
      // a tool error it can only report (docs/TOOLS.md §3).
      const missed = yield* run({ action: "read", algorithm: "native:nosuchthing" })
      expect(missed.output).toContain("Did you mean: native:buffer, gdal:warpreproject?")
      expect(missed.metadata.truncated).toBe(false)

      // Ambiguity is NOT absence: the advice is "choose", not "search", and
      // the candidates are the set the lookup declined to pick between rather
      // than fuzzy neighbours re-guessed after the fact.
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
