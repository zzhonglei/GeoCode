/* --- GeoCode: tripwires for the Brand path patches (docs/PATHS.md). Layers a typecheck cannot reach: the live
 * read paths resolving to branded names, no patched file having regressed to an upstream literal, and the product
 * name in text users and the model read (docs/PATHS.md §3.4). --- */
import { describe, expect, test } from "bun:test"
import path from "path"
import { readFileSync } from "fs"
import { Brand } from "../src/brand"
import { Global } from "../src/global"

const sep = path.sep

describe("brand runtime", () => {
  test("identity strings all derive from one base name", () => {
    expect(Brand.configJson).toBe(`${Brand.name}.json`)
    expect(Brand.configJsonc).toBe(`${Brand.name}.jsonc`)
    expect(Brand.dbFile).toBe(`${Brand.name}.db`)
    expect(Brand.logFile).toBe(`${Brand.name}.log`)
    expect(Brand.mdnsHost).toBe(`${Brand.name}.local`)
    expect(Brand.projectMarker).toBe(Brand.name)
    expect(Brand.stagingMarker).toBe(`.${Brand.name}-version`)
    expect(Brand.managedDomain).toBe(`ai.${Brand.name}.managed`)
    expect(Brand.dirName.toLowerCase()).toBe(Brand.name)
    // The loader checks the directory before looking for the file inside it, so a drift between the two names
    // passes the check and then never finds the file.
    expect(Brand.projectDir).toBe(`.${Brand.name}`)
    expect([...Brand.plansSegments]).toEqual([Brand.projectDir, "plans"])
  })

  test("XDG roots are namespaced under GeoCode", () => {
    for (const root of [Global.Path.data, Global.Path.config, Global.Path.cache, Global.Path.state, Global.Path.tmp]) {
      expect(root.endsWith(`${sep}${Brand.dirName}`)).toBe(true)
    }
  })

  test("database file name is branded (channel-suffixed on local builds)", () => {
    // The test preload pins OPENCODE_DB=":memory:", short-circuiting the branded fallback in this process, so
    // `Database.path()` is resolved in a subprocess without it.
    const env = { ...process.env }
    delete env.OPENCODE_DB
    const script = `import("${path.join(import.meta.dir, "..", "src", "database", "database.ts")}").then((m) => console.log(m.Database.path()))`
    const result = Bun.spawnSync({ cmd: ["bun", "-e", script], env, cwd: path.join(import.meta.dir, "..") })
    const resolved = result.stdout.toString().trim().split("\n").pop() ?? ""
    expect(path.basename(resolved)).toBe(Brand.channelDbFile("local"))
  })
})

describe("brand literal scan", () => {
  // The exact literals each patch replaced, per file: a merge that reverts one turns this red rather than shipping
  // opencode-branded paths.
  const repo = path.join(import.meta.dir, "..", "..", "..")
  const forbidden: Record<string, string[]> = {
    "packages/core/src/global.ts": ['const app = "opencode"'],
    "packages/core/src/database/database.ts": ['"opencode.db"', "opencode-${"],
    "packages/core/src/observability/logging.ts": ['"opencode.log"'],
    "packages/core/src/project.ts": ['"opencode")'],
    "packages/core/src/skill/discovery.ts": ['".opencode-version"'],
    "packages/opencode/src/skill/discovery.ts": ['".opencode-version"'],
    "packages/opencode/src/server/mdns.ts": ['"opencode.local"', "opencode-${"],
    // The yargs default that fed `mdns.ts`. Its own row cannot see this file, and while this literal stood the
    // fallback there was dead code: `domain` was never undefined, so GeoCode advertised opencode.local regardless.
    "packages/opencode/src/cli/network.ts": ['"opencode.local"'],
    // The same host name quoted back at the user, and a row of its own because the mdns row above cannot see this
    // file: restoring the sentence here would advertise a default the server does not serve.
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
    // Two independent project-scope discoveries, both to stay branded: paths.ts serves the instance loader, and
    // core/config.ts is a second one that no flag gates.
    "packages/opencode/src/config/paths.ts": ['targets: [".opencode"]'],
    "packages/core/src/config.ts": ['".opencode"', '"opencode.json"'],
    "packages/opencode/src/config/tui.ts": ['endsWith(".opencode")'],
    "packages/opencode/src/plugin/tui/runtime.ts": ['".opencode"', '".opencode", "themes"', '".opencode", "tui.json"'],
    // The third project-scope discovery. The comment above said two; this one had drifted from both.
    "packages/tui/src/context/theme.tsx": ['".opencode"'],
    // `plug add` wrote its config into the user's repo under the old directory and file name, where the loader
    // then never read it back.
    "packages/opencode/src/plugin/install.ts": ['".opencode"', 'return "opencode"'],
    // The shared OS temp dir, where the file name is the only thing that says whose it is.
    "packages/tui/src/clipboard.ts": ['"opencode-clipboard.png"'],
    "packages/opencode/src/cli/cmd/agent.ts": ['ctx.worktree, ".opencode"'],
    "packages/opencode/src/cli/cmd/mcp.ts": ['"opencode.json"', '"opencode.jsonc"', 'baseDir, ".opencode"'],
    // Plan files: the writer and the plan agent's edit permission both spread Brand.plansSegments, never a literal.
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
      // The patch still present, not merely the literal gone. `isProjectDir` counts — it is defined as
      // `basename === Brand.projectDir`, and config/tui.ts names Brand no other way.
      expect(content.includes("Brand.") || content.includes("isProjectDir")).toBe(true)
    })
  }

  /* --- GeoCode: the cuts that stop a project directory's code from running, and what must survive them — the model
   * providers are registered as internal plugins right beside the external loader that was removed, so a later cut
   * reaches them easily (docs/PATHS.md §7; behavioural proof in opencode/test/geocode-project-config.test.ts). --- */
  test("external plugins and file tools stay unloaded", () => {
    const read = (file: string) => readFileSync(path.join(repo, file), "utf8")

    const loader = read("packages/opencode/src/plugin/loader.ts")
    expect(loader.includes("EXTERNAL_PLUGINS_ENABLED")).toBe(true)

    const internal = read("packages/core/src/plugin/internal.ts")
    expect(/^\s*yield\* add\(ConfigExternalPlugin\.Plugin\)/m.test(internal)).toBe(false)
    // …but the provider plugins on the neighbouring lines stay: they are how every model reaches its SDK.
    expect(/^\s*for \(const item of ProviderPlugins\) yield\* add\(item\)/m.test(internal)).toBe(true)
    expect(/^\s*yield\* add\(ConfigProviderPlugin\.Plugin\)/m.test(internal)).toBe(true)

    const registry = read("packages/opencode/src/tool/registry.ts")
    expect(registry.includes('Glob.scanSync("{tool,tools}')).toBe(false)

    // The SDK is installed only so a user's own plugin or tool file can import it, and neither loads. Comments come
    // off first because upstream's install block is commented out byte-identically rather than deleted
    // (docs/CONVENTIONS.md §5), so what is asked is whether the call is active, not whether the words are present.

    // The stripping is a regex, not a parser, so a `/*` or `*/` inside a string would pair with the wrong delimiter
    // and swallow live code — and it fails open, an over-stripped file having nothing left to match. Hence the
    // delimiter counts, where a sampled live line would only fire if the over-strip happened to reach it.
    const count = (text: string, needle: string) => text.split(needle).length - 1
    for (const file of ["packages/opencode/src/config/config.ts", "packages/opencode/src/config/tui.ts"]) {
      const content = read(file)
      expect(count(content, "/*"), `${file}: unbalanced comment delimiters`).toBe(count(content, "*/"))
      expect(content.replace(/\/\*[\s\S]*?\*\//g, "").includes('name: "@opencode-ai/plugin"')).toBe(false)
    }
  })

  test("session sharing stays off", () => {
    // Both halves: the module constant stops the upload, and the config default has share/session.ts refuse first,
    // naming the configuration rather than the env var the gate below it names.
    const share = readFileSync(path.join(repo, "packages/opencode/src/share/share-next.ts"), "utf8")
    expect(share.includes('process.env["OPENCODE_DISABLE_SHARE"] === "true"')).toBe(false)
    const assembly = readFileSync(path.join(repo, "packages/opencode/src/config/geocode.ts"), "utf8")
    expect(/share:\s*"disabled"/.test(assembly)).toBe(true)
  })

  test("the home-directory scan for a second global root is gone", () => {
    // Upstream also walks ~/.opencode; GeoCode has exactly one global root, so the scan was removed rather than
    // renamed and a merge restoring it would put the second root back.
    const content = readFileSync(path.join(repo, "packages/opencode/src/config/paths.ts"), "utf8")
    expect(content.includes("Global.Path.home")).toBe(false)
  })

  test("coding-oriented upstream agents are disabled by config", () => {
    // Through the assembly layer, never by editing agent.ts, which is upstream's hottest churn area.
    const content = readFileSync(path.join(repo, "packages/opencode/src/config/geocode.ts"), "utf8")
    for (const agent of ["build", "general"]) {
      expect(new RegExp(`${agent}:\\s*\\{\\s*disable:\\s*true`).test(content)).toBe(true)
    }
    // `explore` is deliberately not among them; the reasoning sits in config/geocode.ts beside the entry itself.
    expect(/explore:\s*\{\s*disable:\s*true/.test(content)).toBe(false)
  })

  test("system prompt selector returns the GeoCode base for every model", () => {
    // Upstream picks one of its coding-agent prompts by model id, and its branches are still in the file,
    // byte-identical and unreachable (docs/KERNEL.md §5.2) — so what is pinned is that the GeoCode return comes
    // before any of them. Move it below a branch and agents start calling themselves OpenCode again.
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
    /* The assembly layer holds a full copy, because agent.ts assigns the field wholesale, and a copy in our own
     * file gives git nothing to conflict with when upstream edits its line. So the two intended edits are applied
     * to upstream's text and the result compared, which pins every word we did not touch. */
    const read = (file: string) => readFileSync(path.join(repo, file), "utf8")
    const grab = (source: string) => source.match(/description: `(Fast agent specialized[^`]*)`/)?.[1]

    const upstream = grab(read("packages/opencode/src/agent/agent.ts"))
    const ours = grab(read("packages/opencode/src/config/geocode.ts"))
    expect(upstream).toBeDefined()
    expect(ours).toBeDefined()

    // Before the edits, because `replace` misses silently and an upstream rewrite would otherwise surface as two
    // walls of text differing somewhere in the middle.
    const OPENING = "exploring codebases."
    const THIRD_CASE = `, or answer questions about the codebase (eg. "how do API endpoints work?").`
    expect(upstream).toContain(OPENING)
    expect(upstream).toContain(THIRD_CASE)

    const expected = upstream!
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
    // Prompt files go verbatim to the model and so cannot carry inline GeoCode markers, leaving this as their only
    // guard against a merge restoring the "build" wording for an agent GeoCode replaced.
    const dir = path.join(repo, "packages/opencode/src/session/prompt")
    const buildSwitch = readFileSync(path.join(dir, "build-switch.txt"), "utf8")
    expect(/\bbuild\b/i.test(buildSwitch)).toBe(false)
  })

  test("plan reminder switch-back is generalized off hardcoded build", () => {
    // GeoCode disables build, so a reminder gated on that literal name would never fire at all.
    const content = readFileSync(path.join(repo, "packages/opencode/src/session/reminders.ts"), "utf8")
    expect(content.includes('input.agent.name === "build"')).toBe(false)
    expect(content.includes('input.agent.name !== "plan"')).toBe(true)
  })

  test("gitlab/poe auth plugins stay removed", () => {
    // Their npm bundles embed a compiled copy of core that creates opencode-branded directories on import, where no
    // source patch can reach it (docs/PATHS.md).
    const content = readFileSync(path.join(repo, "packages/opencode/src/plugin/index.ts"), "utf8")
    expect(/^\s*GitlabAuthPlugin,/m.test(content)).toBe(false)
    expect(/^\s*PoeAuthPlugin,/m.test(content)).toBe(false)
    expect(/^\s*import .* from "opencode-gitlab-auth"/m.test(content)).toBe(false)
    expect(/^\s*import .* from "opencode-poe-auth"/m.test(content)).toBe(false)
  })
})

describe("the product name people see", () => {
  test("the OAuth callback pages name GeoCode, with the wordmark left for the icon batch", async () => {
    // Served in the browser after MCP and provider sign-in; frozen-zone text a user reads (docs/KERNEL.md §3).
    const { OauthCallbackPage } = await import("../src/oauth/page")
    const pages = [
      OauthCallbackPage.success({ provider: "MCP" }),
      OauthCallbackPage.success(),
      OauthCallbackPage.error("denied", { provider: "MCP" }),
      OauthCallbackPage.error("denied"),
      OauthCallbackPage.bootstrap({ tokenPath: "/callback", provider: "xAI" }),
    ]
    for (const page of pages) {
      const text = page.replace(/<svg class="wordmark"[\s\S]*?<\/svg>/g, "")
      expect(text).toContain("· GeoCode</title>")
      expect(text).not.toMatch(/opencode/i)
    }
  })

  test("sign-in instructions and credential errors name GeoCode and point at its settings", () => {
    const opencode = path.join(import.meta.dir, "..", "..", "opencode", "src")
    const read = (...parts: string[]) => readFileSync(path.join(opencode, ...parts), "utf8")
    for (const file of ["digitalocean.ts", "snowflake-cortex.ts"]) {
      const instructions = [...read("plugin", file).matchAll(/instructions:\s*"([^"]*in your browser[^"]*)"/g)].map(
        (match) => match[1],
      )
      expect([file, instructions.length]).toEqual([file, 1])
      expect(instructions[0]).toContain("GeoCode")
      expect(instructions[0]).not.toMatch(/opencode/i)
      expect(instructions[0]).not.toMatch(/\/connect\b/)
    }
    // GeoCode ships no CLI, so a hint to run one names a command that does not exist.
    for (const [file, hints] of [
      ["provider.ts", 2],
      ["error.ts", 1],
    ] as const) {
      const code = read("provider", file).replace(/\s\/\/ GeoCode:.*$/gm, "")
      expect(code).not.toMatch(/opencode auth/)
      expect([file, code.match(/Providers settings/g)?.length]).toEqual([file, hints])
    }
  })

  test("bash prints GeoCode's name before its own errors in shell mode", async () => {
    // `$0` of `<shell> -l -c <script> $0 <cwd>` prefixes bash's own errors,
    // e.g. "geocode: gdalinfo: command not found"; zsh does not print it but runs under the same name.
    const { Shell } = await import("../src/shell")
    for (const shell of ["/bin/bash", "/bin/zsh"]) {
      const args = Shell.args(shell, "true", "/tmp")
      expect([shell, args.at(-2)]).toEqual([shell, Brand.name])
    }
  })

  test("the built-in configuration skill is listed under GeoCode's name", () => {
    // Only the name moved; its description and body are the user's to rewrite.
    const sources = [
      [path.join(import.meta.dir, "..", "src", "plugin", "skill.ts"), /name: "(customize-\w+)"/g],
      [
        path.join(import.meta.dir, "..", "..", "opencode", "src", "skill", "index.ts"),
        /CUSTOMIZE_OPENCODE_SKILL_NAME = "(customize-\w+)"/g,
      ],
    ] as const
    for (const [file, pattern] of sources) {
      const names = [...readFileSync(file, "utf8").matchAll(pattern)].map((match) => match[1])
      expect([file, names]).toEqual([file, [`customize-${Brand.name}`]])
    }
  })
})
