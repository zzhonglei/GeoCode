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
    expect(first.state.state).toBe("reachable")
    expect(first.streak).toBe(1)
  })

  test("a second consecutive ambiguous failure does", () => {
    const first = NetMonitor.step(reachable("direct"), failure("other"))
    const second = NetMonitor.step(first, failure("other"))

    expect(second.state.state).toBe("unreachable")
  })

  test("a success in between clears the streak", () => {
    const first = NetMonitor.step(reachable("direct"), failure("other"))
    const recovered = NetMonitor.step(first, { ok: true, routeId: "direct" })
    const afterOne = NetMonitor.step(recovered, failure("other"))

    // Otherwise two failures an hour apart would count as consecutive.
    expect(afterOne.state.state).toBe("reachable")
    expect(afterOne.streak).toBe(1)
  })

  test("an interface-level failure degrades on the very first verdict", () => {
    const immediate = NetMonitor.step(reachable("direct"), failure("offline"))

    // No debounce: the signal is unambiguous, and waiting one out would leave
    // the application claiming to be online while the machine plainly is not
    // (§3.3 快速降级).
    expect(immediate.state.state).toBe("unreachable")
  })

  test("recovery needs no streak of its own", () => {
    const down: NetMonitor.Machine = { state: { state: "unreachable" }, streak: 5 }
    const back = NetMonitor.step(down, { ok: true, routeId: "proxy:127.0.0.1:7890" })

    // The asymmetry is deliberate. A completed handshake with the genuine
    // endpoint does not happen by accident, so the evidence is already
    // conclusive — while failure has many innocent causes. Slow to give up,
    // quick to come back.
    expect(back.state.state).toBe("reachable")
    expect(back.streak).toBe(0)
  })

  test("re-verification is route-aware only while a route is held", () => {
    expect(NetMonitor.shouldRediscover(reachable("direct"))).toBe(false)
    // Losing reachability clears the route, so recovery runs the whole candidate
    // flow again — which is what picks up a proxy the user has just started
    // without them touching anything (§3.3 自动恢复).
    expect(NetMonitor.shouldRediscover({ state: { state: "unreachable" }, streak: 2 })).toBe(true)
    expect(NetMonitor.shouldRediscover(NetMonitor.initial)).toBe(true)
  })

  test("the cadence is the same whichever way the user is waiting", () => {
    // Both directions are somebody waiting: one is a user whose network just
    // broke, the other a user who has just fixed it. There is no reason to serve
    // one of them worse.
    expect(NetMonitor.interval({ state: { state: "unreachable" }, streak: 1 })).toBe(
      NetMonitor.interval(reachable("direct")),
    )
  })

  test("the cadence stays short enough to be worth having", () => {
    // Pinned deliberately. The probe carries no credentials and touches no API
    // path, so remote quota and abuse systems never see it — which makes this
    // interval a question of our own cost, and our own cost is one handshake.
    // A future change that lengthens it is trading away the thing the module
    // exists for, so it should have to edit this line and explain itself.
    expect(NetMonitor.INTERVAL_MS).toBeLessThanOrEqual(5_000)

    // Two consecutive failures to give up a route, so a broken network is known
    // within roughly two rounds.
    expect(NetMonitor.FAILURE_STREAK * NetMonitor.INTERVAL_MS).toBeLessThanOrEqual(15_000)
  })
})

describe("net failure classification", () => {
  test("only interface-level codes take the fast path", () => {
    expect(NetClassifier.classify("ENETDOWN: network is down", true)).toBe("offline")
    expect(NetClassifier.classify("ENETUNREACH: network is unreachable", true)).toBe("offline")
  })

  test("only routable addresses count as having a network", () => {
    // Measured on a real machine: eleven non-internal interfaces, nine of which
    // held nothing but a link-local address. `awdl0` and `llw0` exist for
    // AirDrop and are always present; idle tunnels keep an fe80:: of their own.
    // Counting those made the check answer yes on a laptop with its radio off —
    // exactly the case it exists to catch.
    expect(NetClassifier.routable({ address: "192.168.3.8", internal: false })).toBe(true)
    expect(NetClassifier.routable({ address: "198.18.0.1", internal: false })).toBe(true)

    expect(NetClassifier.routable({ address: "fe80::bcf4:54ff:fe99:77c9", internal: false })).toBe(false)
    expect(NetClassifier.routable({ address: "169.254.1.1", internal: false })).toBe(false)
    expect(NetClassifier.routable({ address: "127.0.0.1", internal: true })).toBe(false)
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
