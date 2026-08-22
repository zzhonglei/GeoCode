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
    // The project config dir shares the base name with the files inside it:
    // the loader checks the directory before looking for the file, so a drift
    // between them would pass the check and never find the file.
    expect(Brand.projectDir).toBe(`.${Brand.name}`)
    expect([...Brand.plansSegments]).toEqual([Brand.projectDir, "plans"])
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
    // The same host name, quoted back at the user in the config schema. A row
    // of its own because it is a different file: restoring the sentence there
    // would advertise a default the server above does not serve, and the mdns
    // row cannot see it.
    "packages/core/src/v1/config/server.ts": ["opencode.local"],
    "packages/opencode/src/config/managed.ts": [
      '"ai.opencode.managed"',
      "Application Support/opencode",
      '"/etc/opencode"',
    ],
    "packages/opencode/src/config/config.ts": [
      'Global.Path.config, "opencode.',
      '["opencode.jsonc", "opencode.json", "config.json"]',
    ],
    "packages/opencode/src/config/tui-migrate.ts": [
      'Global.Path.config, "opencode")',
      '["opencode.json", "opencode.jsonc"]',
      'fileInDirectory(dir, "opencode")',
    ],
    "packages/opencode/src/lsp/server.ts": ['"opencode-jdtls-data"'],
    // Project-scope identity. Both config discoveries have to stay branded:
    // paths.ts serves the instance loader, core/config.ts is a second,
    // independent location-scoped discovery that no flag gates.
    "packages/opencode/src/config/paths.ts": ['targets: [".opencode"]'],
    "packages/core/src/config.ts": ['".opencode"', '"opencode.json"'],
    "packages/opencode/src/config/tui.ts": ['endsWith(".opencode")'],
    "packages/opencode/src/plugin/tui/runtime.ts": ['".opencode"', '".opencode", "themes"', '".opencode", "tui.json"'],
    "packages/opencode/src/cli/cmd/agent.ts": ['ctx.worktree, ".opencode"'],
    "packages/opencode/src/cli/cmd/mcp.ts": ['"opencode.json"', '"opencode.jsonc"', 'baseDir, ".opencode"'],
    // Plan files: the writer and the plan agent's edit permission must both
    // spread Brand.plansSegments, never a literal.
    "packages/opencode/src/session/session.ts": ['".opencode", "plans"'],
    "packages/opencode/src/agent/agent.ts": ['".opencode", "plans"'],
    "packages/core/src/plugin/agent.ts": ['".opencode", "plans"'],
  }

  for (const [file, literals] of Object.entries(forbidden)) {
    test(file, () => {
      const content = readFileSync(path.join(repo, file), "utf8")
      for (const literal of literals) {
        expect(content.includes(literal)).toBe(false)
      }
      // The patch itself must still be present, not merely the literal gone.
      // `isProjectDir` counts: it is defined as `basename === Brand.projectDir`.
      expect(content.includes("Brand.") || content.includes("isProjectDir")).toBe(true)
    })
  }

  /* --- GeoCode: the four cuts that stop a project directory's code from
   * running, plus what must survive them. The behavioural proof lives in
   * opencode/test/geocode-project-config.test.ts; these guard the source
   * against a merge putting a path back, and against a future cut taking the
   * model providers with it — they are registered as internal plugins right
   * beside the external loader that was removed (docs/PATHS.md §7). --- */
  test("external plugins and file tools stay unloaded", () => {
    const read = (file: string) => readFileSync(path.join(repo, file), "utf8")

    const loader = read("packages/opencode/src/plugin/loader.ts")
    expect(loader.includes("EXTERNAL_PLUGINS_ENABLED")).toBe(true)

    const internal = read("packages/core/src/plugin/internal.ts")
    expect(/^\s*yield\* add\(ConfigExternalPlugin\.Plugin\)/m.test(internal)).toBe(false)
    // …but the provider plugins registered on the neighbouring lines must stay:
    // they are how every model reaches its SDK.
    expect(/^\s*for \(const item of ProviderPlugins\) yield\* add\(item\)/m.test(internal)).toBe(true)
    expect(/^\s*yield\* add\(ConfigProviderPlugin\.Plugin\)/m.test(internal)).toBe(true)

    const registry = read("packages/opencode/src/tool/registry.ts")
    expect(registry.includes('Glob.scanSync("{tool,tools}')).toBe(false)

    // The plugin SDK is installed only so a user's own plugin or tool file can
    // import it; neither loads, so neither config loader may install it.
    //
    // Upstream's install block is commented out byte-identically rather than
    // deleted (docs/CONVENTIONS.md §5), so the literal is still somewhere in
    // the file and a plain text search would match it. Comments are stripped
    // first because the question this assertion means is whether the call is
    // ACTIVE, not whether the words appear anywhere. Un-commenting the block
    // turns this red again — confirmed by mutation.
    //
    // The behavioural backstop is geocode-project-config.test.ts, which runs a
    // real loader and asserts the project directory gains no node_modules.
    //
    // Stripping is a regex, not a parser, so a `/*` or `*/` inside a string
    // would pair with the wrong delimiter and swallow a span of live code. That
    // fails OPEN — an over-stripped file has nothing left to match and the
    // assertion passes for the wrong reason — so the precondition is checked
    // directly instead: in a file whose only delimiters are real comments the
    // two counts are equal, and any stray one in a string unbalances them.
    //
    // Checking the delimiters rather than sampling a live line is deliberate. A
    // sampled line only fires if the over-strip happens to reach it, and in
    // both of these files the last `*/` sits above everything worth sampling —
    // an anchor below it could never have been swallowed, so it would have
    // asserted nothing at all.
    const count = (text: string, needle: string) => text.split(needle).length - 1
    for (const file of ["packages/opencode/src/config/config.ts", "packages/opencode/src/config/tui.ts"]) {
      const content = read(file)
      expect(count(content, "/*"), `${file}: unbalanced comment delimiters`).toBe(count(content, "*/"))
      expect(content.replace(/\/\*[\s\S]*?\*\//g, "").includes('name: "@opencode-ai/plugin"')).toBe(false)
    }
  })

  test("session sharing stays off", () => {
    // Both halves matter: the module constant stops the upload, and the config
    // default makes an attempt report "disabled in configuration" rather than
    // handing back an empty share URL.
    const share = readFileSync(path.join(repo, "packages/opencode/src/share/share-next.ts"), "utf8")
    expect(share.includes('process.env["OPENCODE_DISABLE_SHARE"] === "true"')).toBe(false)
    const assembly = readFileSync(path.join(repo, "packages/opencode/src/config/geocode.ts"), "utf8")
    expect(/share:\s*"disabled"/.test(assembly)).toBe(true)
  })

  test("the home-directory scan for a second global root is gone", () => {
    // Upstream also walks ~/.opencode. GeoCode has exactly one global root
    // (Global.Path.config), so that scan was removed rather than renamed —
    // an upstream merge restoring it would reintroduce a second root.
    const content = readFileSync(path.join(repo, "packages/opencode/src/config/paths.ts"), "utf8")
    expect(content.includes("Global.Path.home")).toBe(false)
  })

  test("coding-oriented upstream agents are disabled by config", () => {
    // build/general are removed through the assembly layer, never by editing
    // agent.ts — that file is upstream's hottest churn area.
    const content = readFileSync(path.join(repo, "packages/opencode/src/config/geocode.ts"), "utf8")
    for (const agent of ["build", "general"]) {
      expect(new RegExp(`${agent}:\\s*\\{\\s*disable:\\s*true`).test(content)).toBe(true)
    }
    // `explore` is deliberately NOT among them: it is the far end of upstream's
    // context-offloading route, and three live hints send work to it. The
    // reasoning is in config/geocode.ts beside the entry itself.
    expect(/explore:\s*\{\s*disable:\s*true/.test(content)).toBe(false)
  })

  test("system prompt selector returns the GeoCode base for every model", () => {
    // Upstream picks one of nine coding-agent prompts by model id; GeoCode must
    // return its own single base instead, or agents start calling themselves
    // OpenCode again.
    //
    // What is pinned is that the GeoCode return comes BEFORE any branching.
    // Upstream's branches are still in the file, byte-identical and unreachable
    // (docs/KERNEL.md §5.2) — so asserting their names are absent, which this
    // used to do, would now be asserting the shape of the patch rather than
    // what it achieves. Move the return below a branch and this turns red.
    //
    // The behavioural backstop is opencode/test/session/system.test.ts, which
    // runs the selector over every model family and asserts one prompt out.
    const content = readFileSync(path.join(repo, "packages/opencode/src/session/system.ts"), "utf8")
    const selector = content.slice(content.indexOf("export function provider("))
    expect(selector.slice(0, selector.indexOf("if (")).includes("return [PROMPT_GEOCODE]")).toBe(true)
  })

  test("geocode base prompt is present and speaks as GeoAgent", () => {
    const prompt = readFileSync(path.join(repo, "packages/opencode/src/session/prompt/geocode.txt"), "utf8")
    expect(prompt.startsWith("You are GeoAgent")).toBe(true)
    expect(/opencode/i.test(prompt)).toBe(false)
  })

  test("the explore description stays in step with upstream's", () => {
    /* The assembly layer holds a FULL COPY of upstream's description, because
     * agent.ts assigns the field wholesale — one sentence cannot be extended
     * without restating all of them (config/geocode.ts carries the reasoning).
     *
     * A copy drifts in silence, and that is the whole point of this test:
     * upstream edits its own line, git finds nothing to conflict with because
     * our copy sits in our own file, no test goes red, and from then on one
     * agent is described two different ways depending on which file you read.
     *
     * So the copy is never asserted literally. Upstream's text is read from
     * source, the two intended edits are applied to it, and the result has to
     * equal ours — which pins the additions and, more importantly, every word
     * we did not touch.
     */
    const read = (file: string) => readFileSync(path.join(repo, file), "utf8")
    const grab = (source: string) => source.match(/description: `(Fast agent specialized[^`]*)`/)?.[1]

    const upstream = grab(read("packages/opencode/src/agent/agent.ts"))
    const ours = grab(read("packages/opencode/src/config/geocode.ts"))
    expect(upstream).toBeDefined()
    expect(ours).toBeDefined()

    // Checked before the edits are applied: `replace` misses silently, so an
    // upstream rewrite would otherwise surface as two walls of text differing
    // somewhere in the middle.
    const OPENING = "exploring codebases."
    const THIRD_CASE = `, or answer questions about the codebase (eg. "how do API endpoints work?").`
    expect(upstream).toContain(OPENING)
    expect(upstream).toContain(THIRD_CASE)

    const expected = upstream!
      // Geographic data named in the opening line, in the same words explore.txt uses.
      .replace(OPENING, "exploring codebases and geographic datasets.")
      // A fourth case joined to the list, not bolted on after it: `or` moves along.
      .replace(
        THIRD_CASE,
        `, answer questions about the codebase (eg. "how do API endpoints work?"), or find relevant` +
          ` datasets in a folder of geographic data (eg. "which of these might be useful for this study?").`,
      )
    expect(ours).toBe(expected)
  })

  test("plan mode reminders stay agent-neutral", () => {
    // Prompt files are fed verbatim to the model, so they cannot carry inline
    // GeoCode markers — this assertion is their only guard against an upstream
    // merge restoring the "build" wording (GeoCode replaces that agent).
    //
    // `plan.txt` used to be guarded here too, for naming the explore subagent.
    // GeoCode keeps explore now, so that file is byte-identical to upstream
    // again and has nothing left to defend.
    const dir = path.join(repo, "packages/opencode/src/session/prompt")
    const buildSwitch = readFileSync(path.join(dir, "build-switch.txt"), "utf8")
    expect(/\bbuild\b/i.test(buildSwitch)).toBe(false)
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
