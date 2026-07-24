/* --- GeoCode: tripwire tests for the Brand path patches (docs/PATHS.md).
 * Two layers: runtime assertions verify the live read paths actually resolve
 * to branded names, and literal scans verify no patched file regressed to an
 * upstream literal after a merge (typecheck alone cannot catch either). --- */
import { describe, expect, test } from "bun:test"
import path from "path"
import { readFileSync } from "fs"
import { Brand } from "../src/brand"
import { Global } from "../src/global"

const sep = path.sep

describe("brand runtime", () => {
  test("identity strings all derive from one base name", () => {
    // Guards the single-source-of-truth property: nothing may be a hand-kept
    // literal that could drift from Brand.name after an edit.
    expect(Brand.configJson).toBe(`${Brand.name}.json`)
    expect(Brand.configJsonc).toBe(`${Brand.name}.jsonc`)
    expect(Brand.dbFile).toBe(`${Brand.name}.db`)
    expect(Brand.logFile).toBe(`${Brand.name}.log`)
    expect(Brand.mdnsHost).toBe(`${Brand.name}.local`)
    expect(Brand.projectMarker).toBe(Brand.name)
    expect(Brand.stagingMarker).toBe(`.${Brand.name}-version`)
    expect(Brand.managedDomain).toBe(`ai.${Brand.name}.managed`)
    expect(Brand.dirName.toLowerCase()).toBe(Brand.name)
  })

  test("XDG roots are namespaced under GeoCode", () => {
    for (const root of [Global.Path.data, Global.Path.config, Global.Path.cache, Global.Path.state, Global.Path.tmp]) {
      expect(root.endsWith(`${sep}${Brand.dirName}`)).toBe(true)
    }
  })

  test("database file name is branded (channel-suffixed on local builds)", () => {
    // The test preload pins OPENCODE_DB=":memory:", which short-circuits the
    // branded fallback inside this process — so resolve Database.path() in a
    // subprocess with that override removed. InstallationChannel is "local"
    // for source runs -> geocode-local.db.
    const env = { ...process.env }
    delete env.OPENCODE_DB
    const script = `import("${path.join(import.meta.dir, "..", "src", "database", "database.ts")}").then((m) => console.log(m.Database.path()))`
    const result = Bun.spawnSync({ cmd: ["bun", "-e", script], env, cwd: path.join(import.meta.dir, "..") })
    const resolved = result.stdout.toString().trim().split("\n").pop() ?? ""
    expect(path.basename(resolved)).toBe(Brand.channelDbFile("local"))
  })
})

describe("brand literal scan", () => {
  // For each patched file, the exact upstream literals we replaced must not
  // come back. An upstream merge that reverts a patch turns this red instead
  // of silently shipping opencode-branded paths.
  const repo = path.join(import.meta.dir, "..", "..", "..")
  const forbidden: Record<string, string[]> = {
    "packages/core/src/global.ts": ['const app = "opencode"'],
    "packages/core/src/database/database.ts": ['"opencode.db"', "opencode-${"],
    "packages/core/src/observability/logging.ts": ['"opencode.log"'],
    "packages/core/src/project.ts": ['"opencode")'],
    "packages/core/src/skill/discovery.ts": ['".opencode-version"'],
    "packages/opencode/src/skill/discovery.ts": ['".opencode-version"'],
    "packages/opencode/src/server/mdns.ts": ['"opencode.local"', "opencode-${"],
    "packages/opencode/src/config/managed.ts": [
      '"ai.opencode.managed"',
      "Application Support/opencode",
      '"/etc/opencode"',
    ],
    "packages/opencode/src/config/config.ts": [
      'Global.Path.config, "opencode.',
      '["opencode.jsonc", "opencode.json", "config.json"]',
    ],
    "packages/opencode/src/config/tui-migrate.ts": ['Global.Path.config, "opencode")'],
    "packages/opencode/src/lsp/server.ts": ['"opencode-jdtls-data"'],
  }

  for (const [file, literals] of Object.entries(forbidden)) {
    test(file, () => {
      const content = readFileSync(path.join(repo, file), "utf8")
      for (const literal of literals) {
        expect(content.includes(literal)).toBe(false)
      }
      // The patch itself must still be present, not merely the literal gone.
      expect(content.includes("Brand.")).toBe(true)
    })
  }

  test("coding-oriented upstream agents are disabled by config", () => {
    // build/explore/general are removed through the assembly layer, never by
    // editing agent.ts — that file is upstream's hottest churn area.
    const content = readFileSync(path.join(repo, "packages/opencode/src/config/geocode.ts"), "utf8")
    for (const agent of ["build", "explore", "general"]) {
      expect(new RegExp(`${agent}:\\s*\\{\\s*disable:\\s*true`).test(content)).toBe(true)
    }
  })

  test("system prompt selector returns the GeoCode base for every model", () => {
    // Upstream picks one of nine coding-agent prompts by model id; GeoCode must
    // return its own single base instead, or agents start calling themselves
    // OpenCode again.
    const content = readFileSync(path.join(repo, "packages/opencode/src/session/system.ts"), "utf8")
    expect(content.includes("PROMPT_GEOCODE")).toBe(true)
    for (const upstream of ["PROMPT_ANTHROPIC", "PROMPT_BEAST", "PROMPT_GPT", "PROMPT_DEFAULT"]) {
      expect(content.includes(upstream)).toBe(false)
    }
  })

  test("geocode base prompt is present and speaks as GeoAgent", () => {
    const prompt = readFileSync(path.join(repo, "packages/opencode/src/session/prompt/geocode.txt"), "utf8")
    expect(prompt.startsWith("You are GeoAgent")).toBe(true)
    expect(/opencode/i.test(prompt)).toBe(false)
  })

  test("plan mode reminders stay agent-neutral", () => {
    // Prompt files are fed verbatim to the model, so they cannot carry inline
    // GeoCode markers — these assertions are their only guard against an
    // upstream merge restoring the "build" wording or the explore-subagent
    // reference (GeoCode has neither).
    const dir = path.join(repo, "packages/opencode/src/session/prompt")
    const buildSwitch = readFileSync(path.join(dir, "build-switch.txt"), "utf8")
    expect(/\bbuild\b/i.test(buildSwitch)).toBe(false)
    const plan = readFileSync(path.join(dir, "plan.txt"), "utf8")
    expect(plan.includes("delegate explore agents")).toBe(false)
  })

  test("plan reminder switch-back is generalized off hardcoded build", () => {
    // GeoCode disables build; the reminder must fire for any non-plan agent,
    // not the upstream literal "build" (which would never match).
    const content = readFileSync(path.join(repo, "packages/opencode/src/session/reminders.ts"), "utf8")
    expect(content.includes('input.agent.name === "build"')).toBe(false)
    expect(content.includes('input.agent.name !== "plan"')).toBe(true)
  })

  test("gitlab/poe auth plugins stay removed", () => {
    // Their npm bundles embed a published core copy that mkdirs opencode-
    // branded XDG dirs on import — an unreachable brand leak. An upstream
    // merge re-activating either line turns this red.
    const content = readFileSync(path.join(repo, "packages/opencode/src/plugin/index.ts"), "utf8")
    expect(/^\s*GitlabAuthPlugin,/m.test(content)).toBe(false)
    expect(/^\s*PoeAuthPlugin,/m.test(content)).toBe(false)
    expect(/^\s*import .* from "opencode-gitlab-auth"/m.test(content)).toBe(false)
    expect(/^\s*import .* from "opencode-poe-auth"/m.test(content)).toBe(false)
  })
})
