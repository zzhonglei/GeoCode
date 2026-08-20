// Pure state machine for the permission UI.
//
// Lives outside the JSX component so it can be tested independently. The
// machine has three stages:
//
//   permission → initial view with Allow once / Always / Reject options
//   always     → confirmation step (Confirm / Cancel)
//   reject     → text input for rejection message
//
// permissionRun() is the main transition: given the current state and the
// selected option, it returns a new state and optionally a PermissionReply
// to send to the SDK. The component calls this on enter/click.
//
// permissionInfo() extracts display info (icon, title, lines, diff) from
// the request, delegating to tool.ts for tool-specific formatting.
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import type { PermissionReply } from "./types"
import { toolPath, toolPermissionInfo } from "./tool"

type Dict = Record<string, unknown>

export type PermissionStage = "permission" | "always" | "reject"
export type PermissionOption = "once" | "always" | "reject" | "confirm" | "cancel"

export type PermissionBodyState = {
  requestID: string
  stage: PermissionStage
  selected: PermissionOption
  message: string
  submitting: boolean
}

export type PermissionInfo = {
  icon: string
  title: string
  lines: string[]
  diff?: string
  file?: string
}

export type PermissionStep = {
  state: PermissionBodyState
  reply?: PermissionReply
}

function dict(v: unknown): Dict {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return {}
  }

  return { ...v }
}

function text(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/* --- GeoCode: one parameter value as one line of a dialog.
 *
 * The cut is at a terminal line rather than at the 256 `geo-qgis-run.ts` uses
 * for the same values, and the two numbers are not a drift: that one keeps a
 * PATTERN from exploding and is sized so no real path ever reaches it, this one
 * keeps a DIALOG readable. A path longer than this is already unreadable in a
 * prompt, and the full value stays in the tool's metadata either way. --- */
function render(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean" || value === null
        ? String(value)
        : JSON.stringify(value)
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw
}

function data(request: PermissionRequest): Dict {
  const meta = dict(request.metadata)
  return {
    ...meta,
    ...dict(meta.input),
  }
}

function patterns(request: PermissionRequest): string[] {
  return request.patterns.filter((item): item is string => typeof item === "string")
}

export function createPermissionBodyState(requestID: string): PermissionBodyState {
  return {
    requestID,
    stage: "permission",
    selected: "once",
    message: "",
    submitting: false,
  }
}

export function permissionOptions(stage: PermissionStage): PermissionOption[] {
  if (stage === "permission") {
    return ["once", "always", "reject"]
  }

  if (stage === "always") {
    return ["confirm", "cancel"]
  }

  return []
}

export function permissionInfo(request: PermissionRequest): PermissionInfo {
  const pats = patterns(request)
  const input = data(request)
  const info = toolPermissionInfo(request.permission, input, dict(request.metadata), pats)
  if (info) {
    return info
  }

  if (request.permission === "external_directory") {
    const meta = dict(request.metadata)
    const raw = text(meta.parentDir) || text(meta.filepath) || pats[0] || ""
    const dir = raw.includes("*") ? raw.slice(0, raw.indexOf("*")).replace(/[\\/]+$/, "") : raw
    return {
      icon: "←",
      title: `Access external directory ${toolPath(dir, { home: true })}`,
      lines: pats.map((item) => `- ${item}`),
    }
  }

  if (request.permission === "doom_loop") {
    return {
      icon: "⟳",
      title: "Continue after repeated failures",
      lines: ["This keeps the session running despite repeated failures."],
    }
  }

  /* --- GeoCode: the four geographic permission keys (docs/TOOLS.md §4).
   *
   * Here rather than in tool.ts's TOOL_RULES for the same reason
   * `external_directory` and `doom_loop` are here: that table is keyed by TOOL
   * NAME and demands a `view` and a `run`, while these are PERMISSION KEYS —
   * `qgis` covers two tools, `osm` covers four, and no tool is named after any
   * of them. Registering them there would mean inventing a rendering for a tool
   * that does not exist.
   *
   * Without this the fallback at the bottom renders `Call tool qgis` over
   * `Tool: qgis`, which is a dialog containing none of what the user is being
   * asked to judge — and for `qgis` that judgement is the ONLY guard left
   * (TOOLS.md §4.3: the destination check cannot see 56 of 422 algorithms, and
   * no list of exceptions survives the user's own QGIS version).
   *
   * Two shapes, on purpose. An algorithm call can be read and judged, so it is
   * spelled out; a GEE script cannot — it is arbitrary Python, and unfolding it
   * into a dialog would teach the user to confirm without reading. What that
   * one is asked about is the CAPABILITY, the way upstream's `task` prompt asks
   * about a subagent without pretending to know what it will do. --- */
  if (request.permission === "qgis") {
    const algorithm = text(input.algorithm)
    // `doc:` patterns reach here only if a user narrows the key by hand; the
    // shipped rules allow them outright, since a prompt for reading
    // documentation is a prompt that trains the user to dismiss prompts.
    if (!algorithm) {
      return { icon: "#", title: "QGIS documentation", lines: pats.map((item) => `- ${item}`) }
    }
    const parameters = dict(input.parameters)
    const width = Math.max(0, ...Object.keys(parameters).map((key) => key.length))
    return {
      icon: "#",
      title: `Run QGIS algorithm ${algorithm}`,
      // One parameter per line rather than the single-line form carried in
      // `patterns`: an atlas export takes seventeen of them, and the one that
      // matters — a path outside the working directory — is the one that would
      // wrap off the end of a terminal line.
      lines: Object.entries(parameters).map(([key, value]) => `${key.padEnd(width)} = ${render(value)}`),
    }
  }

  if (request.permission === "gee") {
    const script = text(input.script)
    return {
      icon: "#",
      title: "Run an Earth Engine script",
      // Deliberately not the script body. It runs against the user's Earth
      // Engine credentials and quota, and that — not any one line of Python —
      // is what is being granted.
      lines: [script ? toolPath(script, { home: true }) : "Inline script"],
    }
  }

  if (request.permission === "geodata") {
    return { icon: "#", title: "Read geographic data", lines: pats.map((item) => `- ${item}`) }
  }

  if (request.permission === "osm") {
    // Four tools with four different pattern meanings — a query, a set of
    // extents, an output path — so the patterns are listed as they are rather
    // than given a shape that would be wrong for three of them.
    return { icon: "#", title: "OpenStreetMap", lines: pats.map((item) => `- ${item}`) }
  }

  return {
    icon: "⚙",
    title: `Call tool ${request.permission}`,
    lines: [`Tool: ${request.permission}`],
  }
}

export function permissionAlwaysLines(request: PermissionRequest): string[] {
  if (request.always.length === 1 && request.always[0] === "*") {
    return [`This will allow ${request.permission} until OpenCode is restarted.`]
  }

  return [
    "This will allow the following patterns until OpenCode is restarted.",
    ...request.always.map((item) => `- ${item}`),
  ]
}

export function permissionLabel(option: PermissionOption): string {
  if (option === "once") return "Allow once"
  if (option === "always") return "Allow always"
  if (option === "reject") return "Reject"
  if (option === "confirm") return "Confirm"
  return "Cancel"
}

export function permissionReply(requestID: string, reply: PermissionReply["reply"], message?: string): PermissionReply {
  return {
    requestID,
    reply,
    ...(message && message.trim() ? { message: message.trim() } : {}),
  }
}

export function permissionShift(state: PermissionBodyState, dir: -1 | 1): PermissionBodyState {
  const list = permissionOptions(state.stage)
  if (list.length === 0) {
    return state
  }

  const idx = Math.max(0, list.indexOf(state.selected))
  const selected = list[(idx + dir + list.length) % list.length]
  return {
    ...state,
    selected,
  }
}

export function permissionHover(state: PermissionBodyState, option: PermissionOption): PermissionBodyState {
  return {
    ...state,
    selected: option,
  }
}

export function permissionRun(state: PermissionBodyState, requestID: string, option: PermissionOption): PermissionStep {
  if (state.submitting) {
    return { state }
  }

  if (state.stage === "permission") {
    if (option === "always") {
      return {
        state: {
          ...state,
          stage: "always",
          selected: "confirm",
        },
      }
    }

    if (option === "reject") {
      return {
        state: {
          ...state,
          stage: "reject",
          selected: "reject",
        },
      }
    }

    return {
      state,
      reply: permissionReply(requestID, "once"),
    }
  }

  if (state.stage !== "always") {
    return { state }
  }

  if (option === "cancel") {
    return {
      state: {
        ...state,
        stage: "permission",
        selected: "always",
      },
    }
  }

  return {
    state,
    reply: permissionReply(requestID, "always"),
  }
}

export function permissionReject(state: PermissionBodyState, requestID: string): PermissionReply | undefined {
  if (state.submitting) {
    return undefined
  }

  return permissionReply(requestID, "reject", state.message)
}

export function permissionCancel(state: PermissionBodyState): PermissionBodyState {
  return {
    ...state,
    stage: "permission",
    selected: "reject",
  }
}

export function permissionEscape(state: PermissionBodyState): PermissionBodyState {
  if (state.stage === "always") {
    return {
      ...state,
      stage: "permission",
      selected: "always",
    }
  }

  return {
    ...state,
    stage: "reject",
    selected: "reject",
  }
}
