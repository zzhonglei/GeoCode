import { describe, expect, test } from "bun:test"
import { GeoNet } from "@/geo/net"
import { NetClassifier } from "@/geo/net/classifier"
import { NetMonitor } from "@/geo/net/monitor"

/* Tripwires for the connectivity state machine (docs/GEOKERNEL.md §3.3). */

const reachable = (route: string): NetMonitor.Machine => ({ state: { state: "reachable", route }, streak: 0 })
const failure = (kind: "offline" | "other"): NetMonitor.Verdict => ({ ok: false, kind, detail: "probe failed" })

describe("net monitor transitions", () => {
  test("one ambiguous failure does not give up a working route", () => {
    const first = NetMonitor.step(reachable("direct"), failure("other"))

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

    // Without the reset, two failures an hour apart would count as consecutive.
    expect(afterOne.state.state).toBe("reachable")
    expect(afterOne.streak).toBe(1)
  })

  test("an interface-level failure degrades on the very first verdict", () => {
    const immediate = NetMonitor.step(reachable("direct"), failure("offline"))

    expect(immediate.state.state).toBe("unreachable")
  })

  test("what was tried and what was skipped survive BOTH ways into unreachable", () => {
    // A field one exit carries and the other drops reads as "we did not look" rather than "we did not say".
    const carrying: NetMonitor.Verdict = {
      ok: false,
      kind: "other",
      detail: "connect ETIMEDOUT",
      tried: ["direct", "proxy:127.0.0.1:7890"],
      skipped: ["socks5://127.0.0.1:1080"],
    }

    // The streak path.
    const first = NetMonitor.step(reachable("direct"), carrying)
    const settled = NetMonitor.step(first, carrying)
    expect(settled.state).toEqual({
      state: "unreachable",
      detail: "connect ETIMEDOUT",
      tried: ["direct", "proxy:127.0.0.1:7890"],
      skipped: ["socks5://127.0.0.1:1080"],
    })

    // And the offline fast path, which bypasses the streak.
    const offline = NetMonitor.step(reachable("direct"), { ...carrying, kind: "offline" })
    expect(offline.state).toEqual({
      state: "unreachable",
      detail: "connect ETIMEDOUT",
      tried: ["direct", "proxy:127.0.0.1:7890"],
      skipped: ["socks5://127.0.0.1:1080"],
    })
  })

  test("nothing skipped means no field at all, rather than an empty one", () => {
    const state = NetMonitor.step(reachable("direct"), {
      ok: false,
      kind: "offline",
      detail: "no interface",
      skipped: [],
    }).state
    expect(state).toEqual({ state: "unreachable", detail: "no interface" })
  })

  test("recovery needs no streak of its own", () => {
    const down: NetMonitor.Machine = { state: { state: "unreachable" }, streak: 5 }
    const back = NetMonitor.step(down, { ok: true, routeId: "proxy:127.0.0.1:7890" })

    expect(back.state.state).toBe("reachable")
    expect(back.streak).toBe(0)
  })

  test("re-verification is route-aware only while a route is held", () => {
    expect(NetMonitor.shouldRediscover(reachable("direct"))).toBe(false)
    // Rediscovering is what picks up a proxy the user has just started (§3.3).
    expect(NetMonitor.shouldRediscover({ state: { state: "unreachable" }, streak: 2 })).toBe(true)
    expect(NetMonitor.shouldRediscover(NetMonitor.initial)).toBe(true)
  })

  test("the cadence is the same whichever way the user is waiting", () => {
    expect(NetMonitor.interval({ state: { state: "unreachable" }, streak: 1 })).toBe(
      NetMonitor.interval(reachable("direct")),
    )
  })

  test("the cadence stays short enough to be worth having", () => {
    expect(NetMonitor.INTERVAL_MS).toBeLessThanOrEqual(5_000)

    // The product is what a user actually waits: lengthening either one alone still has to keep this bound.
    expect(NetMonitor.FAILURE_STREAK * NetMonitor.INTERVAL_MS).toBeLessThanOrEqual(15_000)
  })
})

describe("net failure classification", () => {
  test("only interface-level codes take the fast path", () => {
    expect(NetClassifier.classify("ENETDOWN: network is down", true)).toBe("offline")
    expect(NetClassifier.classify("ENETUNREACH: network is unreachable", true)).toBe("offline")
  })

  test("only routable addresses count as having a network", () => {
    expect(NetClassifier.routable({ address: "192.168.3.8", internal: false })).toBe(true)
    expect(NetClassifier.routable({ address: "198.18.0.1", internal: false })).toBe(true)

    expect(NetClassifier.routable({ address: "fe80::bcf4:54ff:fe99:77c9", internal: false })).toBe(false)
    expect(NetClassifier.routable({ address: "169.254.1.1", internal: false })).toBe(false)
    expect(NetClassifier.routable({ address: "127.0.0.1", internal: true })).toBe(false)
  })

  test("having no interface at all is itself the unambiguous signal", () => {
    // The same reason string is ambiguous with an interface present, one test below.
    expect(NetClassifier.classify("ETIMEDOUT: connect timed out", false)).toBe("offline")
  })

  test("everything a flapping link produces stays ambiguous", () => {
    for (const reason of [
      "ETIMEDOUT: connect timed out",
      "ECONNRESET: socket hang up",
      "ECONNREFUSED: connection refused",
      "EAI_AGAIN: getaddrinfo failed",
      "EHOSTUNREACH: no route to host",
      "timed out after 5000ms",
    ]) {
      // The interface is stated rather than probed, so this is about the rule and not the test machine's network.
      expect(NetClassifier.classify(reason, true)).toBe("other")
    }
  })
})

describe("what a failed round carries out with it", () => {
  test("the route that was tried, named the way a route is named", () => {
    const verdict = GeoNet.failed("ECONNREFUSED: connection refused", ["proxy:127.0.0.1:7890"])
    if (verdict.ok) throw new Error("expected a failure")
    expect(verdict.tried).toEqual(["proxy:127.0.0.1:7890"])
    expect(verdict.detail).toBe("ECONNREFUSED: connection refused")
    // Classified, not copied: callers hand over a reason string and get back what `step` branches on.
    expect(verdict.kind).toBe("other")
  })

  test("a declaration that could not be attempted travels with it", () => {
    const before = process.env.ALL_PROXY
    process.env.ALL_PROXY = "socks5://alice:hunter2@127.0.0.1:1080"
    try {
      const verdict = GeoNet.failed("timed out after 5000ms", ["direct"])
      if (verdict.ok) throw new Error("expected a failure")
      // The resolver refuses SOCKS either way (§12), so this is the only place a user learns it was declared.
      expect(verdict.skipped).toEqual(["socks5:127.0.0.1:1080"])
      for (const item of verdict.skipped ?? []) expect(item).not.toContain("hunter2")
    } finally {
      if (before === undefined) delete process.env.ALL_PROXY
      else process.env.ALL_PROXY = before
    }
  })
})
