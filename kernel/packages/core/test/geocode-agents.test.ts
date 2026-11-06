import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Duration, Effect, Exit, Layer, LayerMap, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { GeoAgents } from "@opencode/core/geocode/agents"
import { GeoPlan } from "@opencode/core/geocode/plan"
import { Instance } from "@opencode/core/instance"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionContext } from "@opencode/core/session/context"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"
import { Tool } from "@opencode/core/tool"
import { Provider } from "@opencode/core/provider"
import { Document, Info } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "../src/bus"
import { Database } from "../src/database/database"
import PROMPT from "../src/geocode/system.txt"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const decode = Schema.decodeUnknownSync(Info)
/** The user's config of each test's kernel, by its directory. */
const configs = new Map<string, unknown>()

// Kernels booted with their real plugin list, so the order of GeoCode's plugins in `internal.ts` is the one under test.
const kernels = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const map = yield* LayerMap.make(
      (ref: Location.Ref) => Instance.layer(ref, { discovery: false, replacements: bindings(ref) }),
      { idleTimeToLive: Duration.infinity },
    )
    const bindings = (ref: Location.Ref): LayerNode.Replacements => [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Config.node.replace(
        Config.testLayer([new Document({ type: "document", info: decode(configs.get(ref.directory) ?? {}) })]),
      ),
      LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      Instance.node.replace(
        Layer.succeed(Instance.Service, { provide: (session) => Effect.provide(map.get(session.location)) }),
      ),
    ]
    return map
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SdkPlugins.node, Session.node, LocationServiceMap.node]),
    [Global.node.replace(tempGlobalLayer), offlineModels, LocationServiceMap.node.replace(kernels)],
  ),
)

/** Runs the effect in a kernel of its own, with the given config as the user's. */
const inKernel = <A, E, R>(config: unknown, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const directory = AbsolutePath.make((yield* tmpdirScoped()).path)
    configs.set(directory, config)
    const locations = yield* LocationServiceMap.Service
    return yield* Effect.gen(function* () {
      yield* (yield* Plugin.Service).awaitActivation
      return yield* effect
    }).pipe(Effect.scoped, Effect.provide(locations.get(Location.Ref.make({ directory }))))
  })

const defaultAgent = Effect.gen(function* () {
  const agents = yield* Agent.Service
  return { selected: String((yield* agents.select()).id), build: yield* agents.get(Agent.defaultID) }
})

describe("GeoCode: GeoAgent", () => {
  // Guards against a session starting on OpenCode's coding agent, or on Plan.
  it.live("is the default agent in build's place", () =>
    Effect.gen(function* () {
      const found = yield* inKernel({}, defaultAgent)

      expect(found.selected).toBe("geoagent")
      expect(found.build).toBeUndefined()
    }),
  )

  // Guards against the user's config bringing back build, which the config's ordinary update would create anew.
  it.live("keeps build closed whatever the user's config says of it", () =>
    Effect.gen(function* () {
      const found = yield* inKernel({ agents: { build: { description: "Builds" } } }, defaultAgent)

      expect(found.build).toBeUndefined()
    }),
  )

  // Guards against a default the user's config names but that is not there, a typo among them, starting sessions on
  // Plan, the first primary agent after GeoAgent.
  it.live("is the default where the user's config names one that is not there", () =>
    Effect.gen(function* () {
      const found = yield* inKernel({ default_agent: "geoagnet" }, defaultAgent)

      expect(found.selected).toBe("geoagent")
    }),
  )
})

describe("GeoCode: the default prompt", () => {
  // Guards against an agent without a prompt of its own reaching a model with OpenCode's coding prompt, or with the
  // variant OpenCode keeps for that model, and against the replacement landing on the instructions instead.
  it.live("is GeoCode's for every model, in place of the base prompt alone", () =>
    inKernel(
      {},
      Effect.gen(function* () {
        const geoagent = yield* (yield* Agent.Service).get(GeoAgents.id)
        if (!geoagent) throw new Error("expected GeoAgent")
        const tools = yield* (yield* Tool.Service).snapshot(geoagent.permissions)
        const requests = (yield* SessionContext.Service).request
        // A session of the kernel's own, as the request's hooks read it.
        const session = yield* (yield* Session.Service).create({
          location: Location.Ref.make({ directory: (yield* Location.Service).directory }),
        })
        const instructions = "Instructions from: /project/AGENTS.md"

        for (const id of ["gpt-5", "gpt-6-astra", "claude-sonnet-4", "kimi-k2", "gemini-2.5-pro"]) {
          const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id, provider: "test" }), {
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: [],
            limit: { context: 200_000, output: 32_000 },
          })
          const transcript = SessionModelRequest.baseTranscript({
            agent: geoagent,
            model,
            tools,
            initial: [{ key: Instructions.Key.make("core/instructions"), text: instructions }],
            messages: [],
          })
          const prepared = yield* requests.primary({
            session,
            agent: GeoAgents.id,
            model,
            tools,
            system: transcript.system,
            messages: [],
          })

          const system = prepared.request.system.map((part) => part.text)
          expect(system[0]).toBe(SessionSystemPrompt.render(PROMPT, Object.keys(prepared.event.tools)))
          expect(system.some((text) => text.includes(instructions))).toBe(true)
        }
      }),
    ),
  )
})

describe("GeoCode: Plan mode", () => {
  // Guards against Plan mode writing data with a geo tool, and against the refusal reaching other agents or the geo
  // tools that only look; Plan is the agent OpenCode registers under this ID.
  it.live("refuses the geo tools that write data, and only them", () =>
    inKernel(
      {},
      Effect.gen(function* () {
        const plan = Agent.ID.make("plan")
        expect(yield* (yield* Agent.Service).get(plan)).toBeDefined()
        const hooks = yield* PluginHooks.Service
        const before = (tool: string, agent: Agent.ID) =>
          hooks
            .trigger("tool", "execute.before", {
              tool,
              sessionID: Session.ID.make("ses_geocode_plan"),
              agent,
              messageID: SessionMessage.ID.make("msg_geocode_plan"),
              id: Tool.CallID.make("call_geocode_plan"),
              input: {},
            })
            .pipe(Effect.exit)

        for (const tool of ["qgisrun", "osmgetobjects", "osmgetfeatures"]) {
          expect(Exit.isFailure(yield* before(tool, plan))).toBe(true)
          expect(Exit.isSuccess(yield* before(tool, GeoAgents.id))).toBe(true)
        }
        for (const tool of ["geerun", "readgeodata", "osmprobe"])
          expect(Exit.isSuccess(yield* before(tool, plan))).toBe(true)
      }),
    ),
  )

  // Guards against a merge of OpenCode leaving Plan mode on its own reminder, which the patch in plugin/plan.ts replaces.
  it.live("starts with GeoCode's reminder", () =>
    inKernel(
      {},
      Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({
          location: Location.Ref.make({ directory: (yield* Location.Service).directory }),
        })
        const event = {
          sessionID: session.id,
          agent: Agent.ID.make("plan"),
          model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("gpt-5") }),
          system: [],
          messages: [Message.user("Plan the land cover analysis.")],
          tools: {},
          options: {},
        }
        yield* (yield* PluginHooks.Service).trigger("session", "context", event)

        const reminder = event.messages
          .flatMap((message) => message.content)
          .flatMap((part) => (part.type === "text" && part.text.startsWith("<system-reminder>") ? [part.text] : []))
        expect(reminder).toHaveLength(1)
        // The Plan directory is the third line; the rest must be GeoCode's text around it.
        expect(reminder[0]).toBe(GeoPlan.enter(reminder[0]?.split("\n")[2] ?? ""))
      }),
    ),
  )
})

describe("GeoCode: Claude Agent", () => {
  // Guards against a merge of OpenCode bringing back the Claude Agent provider, which offers the user's Claude
  // subscription and which the patch in plugin/provider.ts closes.
  it.live("is not a provider", () =>
    inKernel(
      {},
      Effect.gen(function* () {
        expect(yield* (yield* Provider.Service).get(Provider.ID.make("claude-agent"))).toBeUndefined()
      }),
    ),
  )
})
