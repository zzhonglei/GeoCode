/* --- GeoCode: a merge that reverts a Brand patch still type-checks, and ships opencode-branded paths or product
 * name (docs/PATHS.md). --- */
import { describe, expect, test } from "bun:test"
import path from "path"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
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
    expect(Brand.projectDir).toBe(`.${Brand.name}`)
    expect([...Brand.plansSegments]).toEqual([Brand.projectDir, "plans"])
  })

  test("XDG roots are namespaced under GeoCode", () => {
    for (const root of [Global.Path.data, Global.Path.config, Global.Path.cache, Global.Path.state, Global.Path.tmp]) {
      expect(root.endsWith(`${sep}${Brand.dirName}`)).toBe(true)
    }
  })

  test("database file name is branded (channel-suffixed on local builds)", () => {
    const env = { ...process.env }
    // The test preload pins OPENCODE_DB to ":memory:", so the path is resolved in a subprocess without it.
    delete env.OPENCODE_DB
    const script = `import("${path.join(import.meta.dir, "..", "src", "database", "database.ts")}").then((m) => console.log(m.Database.path()))`
    const result = Bun.spawnSync({ cmd: ["bun", "-e", script], env, cwd: path.join(import.meta.dir, "..") })
    const resolved = result.stdout.toString().trim().split("\n").pop() ?? ""
    expect(path.basename(resolved)).toBe(Brand.channelDbFile("local"))
  })
})

describe("brand literal scan", () => {
  const repo = path.join(import.meta.dir, "..", "..", "..")
  const forbidden: Record<string, string[]> = {
    "packages/core/src/global.ts": ['const app = "opencode"'],
    "packages/core/src/database/database.ts": ['"opencode.db"', "opencode-${"],
    "packages/core/src/observability/logging.ts": ['"opencode.log"'],
    "packages/core/src/project.ts": ['"opencode")'],
    "packages/core/src/skill/discovery.ts": ['".opencode-version"'],
    "packages/opencode/src/skill/discovery.ts": ['".opencode-version"'],
    "packages/opencode/src/server/mdns.ts": ['"opencode.local"', "opencode-${"],
    // Its yargs default overrides the branded fallback in mdns.ts, so the mdns row alone would pass.
    "packages/opencode/src/cli/network.ts": ['"opencode.local"'],
    // The mDNS default quoted to the user, which must name the host actually served.
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
    "packages/opencode/src/config/paths.ts": ['targets: [".opencode"]'],
    "packages/core/src/config.ts": ['".opencode"', '"opencode.json"'],
    "packages/opencode/src/config/tui.ts": ['endsWith(".opencode")'],
    "packages/opencode/src/plugin/tui/runtime.ts": ['".opencode"', '".opencode", "themes"', '".opencode", "tui.json"'],
    "packages/tui/src/context/theme.tsx": ['".opencode"'],
    "packages/opencode/src/plugin/install.ts": ['".opencode"', 'return "opencode"'],
    // The shared OS temp dir, where the file name is the only thing that says whose it is.
    "packages/tui/src/clipboard.ts": ['"opencode-clipboard.png"'],
    "packages/opencode/src/cli/cmd/agent.ts": ['ctx.worktree, ".opencode"'],
    "packages/opencode/src/cli/cmd/mcp.ts": ['"opencode.json"', '"opencode.jsonc"', 'baseDir, ".opencode"'],
    "packages/opencode/src/session/session.ts": ['".opencode", "plans"'],
    "packages/opencode/src/agent/agent.ts": ['".opencode", "plans"'],
    "packages/core/src/plugin/agent.ts": ['".opencode", "plans"'],
  }

  /* --- GeoCode: the map above only refuses what it names, so a file nobody listed leaks in silence — which
   * is how three defects reached 2026-09-21 (docs/CONVENTIONS.md). This scan inverts the default: every
   * file-shaped or directory-shaped `opencode` literal in the kernel's source has to be exempted here, by
   * its own text, with a reason. Wire names are filtered rather than exempted one by one, because they are
   * code identity and stay upstream's: module specifiers, URLs, HTTP headers, Effect service ids. --- */
  const WIRE = [/^@opencode(-ai)?\//, /:\/\//, /^x-opencode-/, /^~opencode\//]
  // A closed set of extensions on purpose: `opencode.status` and `opencode.mode` are an event and a flag,
  // and letting any dotted word through would have buried the real hits under them.
  const PATH_SHAPED = [
    /^\.opencode/,
    /^opencode(-[a-z0-9]+)*\.(json|jsonc|db|log|png|md|yml|yaml|toml|txt)$/,
    /\/opencode/,
    /opencode\//,
  ]

  // Whole files whose `opencode` text is prose rather than a path this product computes. Coarser than the
  // literal exemptions below, and that is the trade: a reworded upstream tip would otherwise turn this red
  // on every merge. A file listed here still has to earn its line.
  const EXEMPT_FILES: Record<string, string> = {
    "packages/tui/src/feature-plugins/home/tips-view.tsx": "tips the TUI prints, and the TUI is not a GeoCode surface",
    "packages/opencode/src/cli/cmd/github.handler.ts": "the `/opencode` slash command, a GitHub wire name",
    "packages/opencode/src/skill/index.ts": "the builtin skill body, which the user rewrites in the kernel round",
    "packages/core/src/plugin/skill.ts": "the second hand-copy of that same body",
  }

  const EXEMPT_LITERALS: Record<string, string> = {
    // Upstream's own installer layout, read only to report how it was installed. GeoCode ships as an
    // application and never writes here (docs/DESKTOP.md §7.3 rules self-upgrade out).
    ".opencode/bin": "installation/index.ts names the install method",
    ".opencode": "the same check, whose join spells the two segments apart",
    // A source path quoted inside a demo transcript, not a path anything opens.
    "packages/opencode/src/cli/cmd/run/stream.ts": "cli/cmd/run/demo.ts, sample output",
    // An unreferenced development plugin, byte-identical to upstream; nothing in the tree imports it.
    "/tmp/opencode-workspace-dev-data.json": "control-plane/dev/debug-workspace-plugin.ts, no importer",
    // Data files inside the catalogs, named by their publisher rather than by us.
    "./assets/opencode.json": "models.dev catalog asset",
    "./themes/opencode.json": "theme catalog asset",
    "./provider/opencode": "provider plugin directory in the catalog",
    // Upstream's own distribution names, quoted to the user by the CLI.
    "anomalyco/tap/opencode": "uninstall.ts, the homebrew tap",
  }

  const literalsIn = (source: string): string[] =>
    (source.match(/"[^"\n]*opencode[^"\n]*"|'[^'\n]*opencode[^'\n]*'/g) ?? [])
      .map((quoted) => quoted.slice(1, -1))
      .filter((text) => !WIRE.some((pattern) => pattern.test(text)))
      .filter((text) => PATH_SHAPED.some((pattern) => pattern.test(text)))

  test("no unexempted file or directory in the kernel's source is named after OpenCode", () => {
    const roots = readdirSync(path.join(repo, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(repo, "packages", entry.name, "src"))
      .filter((dir) => existsSync(dir))
    const found = new Map<string, string>()
    for (const root of roots) {
      for (const relative of readdirSync(root, { recursive: true }) as string[]) {
        if (!/\.tsx?$/.test(relative)) continue
        const file = path.join(root, relative)
        if (!statSync(file).isFile()) continue
        for (const literal of literalsIn(readFileSync(file, "utf8"))) {
          if (!found.has(literal)) found.set(literal, path.relative(repo, file))
        }
      }
    }
    // Reported with the file that holds each one, so a red run says where to look rather than only what.
    const unexempted = [...found]
      .filter(([literal, file]) => !(literal in EXEMPT_LITERALS) && !(file in EXEMPT_FILES))
      .map(([literal, file]) => `${file}: ${literal}`)
    expect([roots.length > 0, unexempted]).toEqual([true, []])
  })

  for (const [file, literals] of Object.entries(forbidden)) {
    test(file, () => {
      const content = readFileSync(path.join(repo, file), "utf8")
      for (const literal of literals) {
        expect(content.includes(literal)).toBe(false)
      }
      // A file rewritten without the literal would otherwise pass; config/tui.ts reaches Brand only via isProjectDir.
      expect(content.includes("Brand.") || content.includes("isProjectDir")).toBe(true)
    })
  }

  /* --- GeoCode: a merge restoring these loaders runs code from a project directory, and a cut beside them can take
   * the provider plugins too (docs/KERNEL.md §6 items 1-2). --- */
  test("external plugins and file tools stay unloaded", () => {
    const read = (file: string) => readFileSync(path.join(repo, file), "utf8")

    const loader = read("packages/opencode/src/plugin/loader.ts")
    expect(loader.includes("EXTERNAL_PLUGINS_ENABLED")).toBe(true)

    const internal = read("packages/core/src/plugin/internal.ts")
    expect(/^\s*yield\* add\(ConfigExternalPlugin\.Plugin\)/m.test(internal)).toBe(false)
    // The provider plugins registered beside it must stay: models get their SDK clients from them.
    expect(/^\s*for \(const item of ProviderPlugins\) yield\* add\(item\)/m.test(internal)).toBe(true)
    expect(/^\s*yield\* add\(ConfigProviderPlugin\.Plugin\)/m.test(internal)).toBe(true)

    const registry = read("packages/opencode/src/tool/registry.ts")
    expect(registry.includes('Glob.scanSync("{tool,tools}')).toBe(false)

    // The plugin SDK install must stay inactive; upstream's block survives byte-identical inside a comment.
    // The strip is a regex that fails open on a stray delimiter inside a string, hence the delimiter counts.
    const count = (text: string, needle: string) => text.split(needle).length - 1
    for (const file of ["packages/opencode/src/config/config.ts", "packages/opencode/src/config/tui.ts"]) {
      const content = read(file)
      expect(count(content, "/*"), `${file}: unbalanced comment delimiters`).toBe(count(content, "*/"))
      expect(content.replace(/\/\*[\s\S]*?\*\//g, "").includes('name: "@opencode-ai/plugin"')).toBe(false)
    }
  })

  test("session sharing stays off", () => {
    // Both halves: share-next.ts is off by default, and the config default has share/session.ts refuse first,
    // naming the configuration rather than the env var.
    const share = readFileSync(path.join(repo, "packages/opencode/src/share/share-next.ts"), "utf8")
    expect(share.includes('process.env["OPENCODE_DISABLE_SHARE"] === "true"')).toBe(false)
    const assembly = readFileSync(path.join(repo, "packages/opencode/src/config/geocode.ts"), "utf8")
    expect(/share:\s*"disabled"/.test(assembly)).toBe(true)
  })

  test("the home-directory scan for a second global root is gone", () => {
    const content = readFileSync(path.join(repo, "packages/opencode/src/config/paths.ts"), "utf8")
    expect(content.includes("Global.Path.home")).toBe(false)
  })

  test("coding-oriented upstream agents are disabled by config", () => {
    const content = readFileSync(path.join(repo, "packages/opencode/src/config/geocode.ts"), "utf8")
    for (const agent of ["build", "general"]) {
      expect(new RegExp(`${agent}:\\s*\\{\\s*disable:\\s*true`).test(content)).toBe(true)
    }
    // explore is deliberately kept enabled (config/geocode.ts).
    expect(/explore:\s*\{\s*disable:\s*true/.test(content)).toBe(false)
  })

  test("system prompt selector returns the GeoCode base for every model", () => {
    // Upstream's per-model prompts, which introduce themselves as opencode, stay in the file below the GeoCode return.
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
    // The copy in config/geocode.ts draws no merge conflict when upstream edits its own, so drift shows only here.
    const read = (file: string) => readFileSync(path.join(repo, file), "utf8")
    const grab = (source: string) => source.match(/description: `(Fast agent specialized[^`]*)`/)?.[1]

    const upstream = grab(read("packages/opencode/src/agent/agent.ts"))
    const ours = grab(read("packages/opencode/src/config/geocode.ts"))
    expect(upstream).toBeDefined()
    expect(ours).toBeDefined()

    const OPENING = "exploring codebases."
    const THIRD_CASE = `, or answer questions about the codebase (eg. "how do API endpoints work?").`
    expect(upstream).toContain(OPENING)
    expect(upstream).toContain(THIRD_CASE)

    const expected = upstream!
      .replace(OPENING, "exploring codebases and geographic datasets.")
      .replace(
        THIRD_CASE,
        `, answer questions about the codebase (eg. "how do API endpoints work?"), or find relevant` +
          ` datasets in a folder of geographic data (eg. "which of these might be useful for this study?").`,
      )
    expect(ours).toBe(expected)
  })

  test("plan mode reminders stay agent-neutral", () => {
    // Prompt files carry no GeoCode markers, so this alone catches a merge restoring the build wording.
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
  test("the OAuth callback pages name GeoCode, wordmark included", async () => {
    const { OauthCallbackPage } = await import("../src/oauth/page")
    const pages = [
      OauthCallbackPage.success({ provider: "MCP" }),
      OauthCallbackPage.success(),
      OauthCallbackPage.error("denied", { provider: "MCP" }),
      OauthCallbackPage.error("denied"),
      OauthCallbackPage.bootstrap({ tokenPath: "/callback", provider: "xAI" }),
    ]
    for (const page of pages) {
      expect(page).toContain("· GeoCode</title>")
      expect(page).not.toMatch(/opencode/i)
      // Names alone would pass with upstream's mark and a renamed label, so the proportions of our own
      // asset are what is checked.
      expect(page).toContain('viewBox="0 0 512 112"')
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
    const { Shell } = await import("../src/shell")
    for (const shell of ["/bin/bash", "/bin/zsh"]) {
      const args = Shell.args(shell, "true", "/tmp")
      expect([shell, args.at(-2)]).toEqual([shell, Brand.name])
    }
  })

  test("the built-in configuration skill is listed under GeoCode's name", () => {
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
