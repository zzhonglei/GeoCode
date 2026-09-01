// Answers "would the Agent Kernel see this?" for one config root, using the kernel's own
// loaders, constants and schema rather than a hand-copy of them. Reads only.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
// Bare `@opencode-ai/*` specifiers only resolve from inside the kernel install root, so every
// import here goes through a source path; those files then resolve their own dependencies.
import { Brand } from "../../kernel/packages/core/src/brand"
import { Glob } from "../../kernel/packages/core/src/util/glob"
import { ConfigV1 } from "../../kernel/packages/core/src/v1/config/config"
import { ConfigParse } from "../../kernel/packages/opencode/src/config/parse"
import { ConfigAgent } from "../../kernel/packages/opencode/src/config/agent"
import { ConfigCommand } from "../../kernel/packages/opencode/src/config/command"
import { ConfigPlugin } from "../../kernel/packages/opencode/src/config/plugin"

// Importing `Global` creates its roots, so refuse to run against the real home.
if (!process.env.XDG_CONFIG_HOME) throw new Error("set XDG_CONFIG_HOME before running this")
const { Global } = await import("../../kernel/packages/core/src/global")

const root = Global.Path.config

// The skill pattern is module-private in `skill/index.ts`; read it out of the source so this
// tracks a rename instead of pinning a copy.
const skillSource = fs.readFileSync(
  fileURLToPath(new URL("../../kernel/packages/opencode/src/skill/index.ts", import.meta.url)),
  "utf8",
)
const skillPattern = skillSource.match(/OPENCODE_SKILL_PATTERN = "([^"]+)"/)?.[1]
if (!skillPattern) throw new Error("could not read OPENCODE_SKILL_PATTERN from the kernel")

// The three global layers `config/config.ts` loads, in its order.
const layers = ["config.json", Brand.configJson, Brand.configJsonc].map((name) => {
  const file = path.join(root, name)
  if (!fs.existsSync(file)) return { name, exists: false }
  const parsed = ConfigParse.jsonc(fs.readFileSync(file, "utf8"), file) as Record<string, unknown>
  // Decoding with the kernel's own schema answers the other half of the round trip: not just
  // "is the file one it loads" but "is the shape one it accepts".
  let schemaError: string | null = null
  try {
    ConfigParse.schema(ConfigV1.Info, parsed, file)
  } catch (error) {
    schemaError = String(error)
  }
  return {
    name,
    exists: true,
    keys: Object.keys(parsed),
    mcp: Object.keys((parsed.mcp ?? {}) as object),
    provider: Object.keys((parsed.provider ?? {}) as object),
    schemaError,
  }
})

console.log(
  JSON.stringify(
    {
      configRoot: root,
      skillPattern,
      layers,
      agents: Object.keys(await ConfigAgent.load(root)),
      commands: Object.keys(await ConfigCommand.load(root)),
      plugins: await ConfigPlugin.load(root),
      skills: (await Glob.scan(skillPattern, { cwd: root, absolute: true })).map((p) =>
        path.basename(path.dirname(p)),
      ),
      agentsMd: fs.existsSync(path.join(root, "AGENTS.md")),
    },
    null,
    2,
  ),
)
