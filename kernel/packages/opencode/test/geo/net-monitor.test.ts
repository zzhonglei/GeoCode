import { describe, expect, test } from "bun:test"
import { NetClassifier } from "@/geo/net/classifier"
import { NetMonitor } from "@/geo/net/monitor"

/* The connectivity state machine (docs/GEOKERNEL.md §3.3 监视).
 *
 * A pure function, so the two rules that are easiest to get subtly wrong —
 * hysteresis, and the fast path that deliberately bypasses it — can be checked
 * exactly rather than approximately. */

const reachable = (route: string): NetMonitor.Machine => ({ state: { state: "reachable", route }, streak: 0 })
const failure = (kind: "offline" | "other"): NetMonitor.Verdict => ({ ok: false, kind, detail: "probe failed" })

describe("net monitor transitions", () => {
  test("one ambiguous failure does not give up a working route", () => {
    const first = NetMonitor.step(reachable("direct"), failure("other"))

    // Timeouts and resets are exactly what a flapping link produces. Flipping on
    // the first one makes the indicator blink rather than inform.
    expect(first.next.state.state).toBe("reachable")
    expect(first.next.streak).toBe(1)
    expect(first.invalidateRanking).toBe(false)
  })

  test("a second consecutive ambiguous failure does", () => {
    const first = NetMonitor.step(reachable("direct"), failure("other"))
    const second = NetMonitor.step(first.next, failure("other"))

    expect(second.next.state.state).toBe("unreachable")
    expect(second.invalidateRanking).toBe(true)
  })

  test("a success in between clears the streak", () => {
    const first = NetMonitor.step(reachable("direct"), failure("other"))
    const recovered = NetMonitor.step(first.next, { ok: true, routeId: "direct" })
    const afterOne = NetMonitor.step(recovered.next, failure("other"))

    // Otherwise two failures an hour apart would count as consecutive.
    expect(afterOne.next.state.state).toBe("reachable")
    expect(afterOne.next.streak).toBe(1)
  })

  test("an interface-level failure degrades on the very first verdict", () => {
    const immediate = NetMonitor.step(reachable("direct"), failure("offline"))

    // No debounce: the signal is unambiguous, and waiting one out would leave
    // the application claiming to be online while the machine plainly is not
    // (§3.3 快速降级).
    expect(immediate.next.state.state).toBe("unreachable")
    expect(immediate.invalidateRanking).toBe(true)
  })

  test("recovery needs no streak of its own", () => {
    const down: NetMonitor.Machine = { state: { state: "unreachable" }, streak: 5 }
    const back = NetMonitor.step(down, { ok: true, routeId: "proxy:127.0.0.1:7890" })

    // The asymmetry is deliberate. A completed handshake with the genuine
    // endpoint does not happen by accident, so the evidence is already
    // conclusive — while failure has many innocent causes. Slow to give up,
    // quick to come back.
    expect(back.next.state.state).toBe("reachable")
    expect(back.next.streak).toBe(0)
  })

  test("rankings die exactly when the route identity changes", () => {
    // Same route, still working: nothing has changed, so nothing is discarded.
    const steady = NetMonitor.step(reachable("direct"), { ok: true, routeId: "direct" })
    expect(steady.invalidateRanking).toBe(false)

    // A proxy appeared and traffic moved onto it: measurements taken over the
    // old path no longer describe anything.
    const moved = NetMonitor.step(reachable("direct"), { ok: true, routeId: "proxy:127.0.0.1:7890" })
    expect(moved.invalidateRanking).toBe(true)

    // Connectivity lost — "no route" is an identity of its own.
    const lost = NetMonitor.step(reachable("direct"), failure("offline"))
    expect(lost.invalidateRanking).toBe(true)

    // Regained. Even landing on the same identifier, the conditions the old
    // measurements were taken under have demonstrably come and gone.
    const regained = NetMonitor.step(lost.next, { ok: true, routeId: "direct" })
    expect(regained.invalidateRanking).toBe(true)

    // And a failure while already down changes nothing to discard.
    const stillDown = NetMonitor.step(lost.next, failure("other"))
    expect(stillDown.invalidateRanking).toBe(false)
  })

  test("re-verification is route-aware only while a route is held", () => {
    expect(NetMonitor.shouldRediscover(reachable("direct"))).toBe(false)
    // Losing reachability clears the route, so recovery runs the whole candidate
    // flow again — which is what picks up a proxy the user has just started
    // without them touching anything (§3.3 自动恢复).
    expect(NetMonitor.shouldRediscover({ state: { state: "unreachable" }, streak: 2 })).toBe(true)
    expect(NetMonitor.shouldRediscover(NetMonitor.initial)).toBe(true)
  })

  test("a degraded target is re-checked more often than a healthy one", () => {
    // The degraded interval is the window a user waits in after starting their
    // proxy software, and noticing is meant to need nothing from them.
    expect(NetMonitor.interval({ state: { state: "unreachable" }, streak: 1 })).toBeLessThan(
      NetMonitor.interval(reachable("direct")),
    )
  })
})

describe("net failure classification", () => {
  test("only interface-level codes take the fast path", () => {
    expect(NetClassifier.classify("ENETDOWN: network is down", true)).toBe("offline")
    expect(NetClassifier.classify("ENETUNREACH: network is unreachable", true)).toBe("offline")
  })

  test("having no interface at all is itself the unambiguous signal", () => {
    // The most direct interface-level evidence there is: rather than inferring
    // from an error code, ask. A laptop with its radio off answers at once.
    expect(NetClassifier.classify("ETIMEDOUT: connect timed out", false)).toBe("offline")
  })

  test("everything a flapping link produces stays ambiguous", () => {
    // Host-level and transport-level failures are absent from the fast path on
    // purpose: each can equally mean one service is having a bad day, which is
    // the ambiguity hysteresis exists to absorb.
    for (const reason of [
      "ETIMEDOUT: connect timed out",
      "ECONNRESET: socket hang up",
      "ECONNREFUSED: connection refused",
      "EAI_AGAIN: getaddrinfo failed",
      "EHOSTUNREACH: no route to host",
      "timed out after 5000ms",
    ]) {
      // Stated explicitly, so the assertion is about the classification rule
      // rather than about whether the machine running the test has a network.
      expect(NetClassifier.classify(reason, true)).toBe("other")
    }
  })
})
