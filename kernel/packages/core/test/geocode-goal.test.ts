import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionBackground } from "@opencode/core/session/background"

describe("GeoCode: geerun in the background", () => {
  // Guards against /goal's reviewer judging a goal without the run: it waits on a run only as it does on a shell.
  test("is told to plugins as a shell of its Session is", async () => {
    const sessionID = Session.ID.make("ses_goal")
    const run: Job.Recovery = {
      kind: "geerun",
      sessionID,
      task: "ndvi",
      description: "Mean NDVI of the park",
      callID: "call_geerun",
    }
    const background = await Effect.runPromise(
      SessionBackground.outstanding(
        { runningBackground: Effect.succeed([run]) },
        { get: () => Effect.succeed(undefined) },
        sessionID,
      ),
    )
    expect(background.map((work) => [work.kind, work.sessionID])).toEqual([["shell", sessionID]])
  })
})
