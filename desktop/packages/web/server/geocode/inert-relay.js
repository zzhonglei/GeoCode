/* --- GeoCode: the relay service under Electron (docs/DESKTOP.md §6.1, §7.3).
 *
 * Upstream's service owns a host client that dials relay.openchamber.dev, a claim-watch timer,
 * three management routes, and a per-machine key pair it writes into settings.json the first
 * time anything asks for the server id. The desktop shell has no paired devices to serve, so
 * createRelayService hands back this object instead: the same eight methods, none of which
 * reaches the network, the disk or the router. Readers of the server id get null, the value
 * upstream already uses for "no relay service". --- */

const DISABLED_STATUS = Object.freeze({
  enabled: false,
  state: 'disabled',
  serverId: null,
  connectedClients: 0,
  relayUrl: null,
  relayUrlLocked: true,
});

export const createInertRelayService = () => ({
  registerRoutes: () => {},
  startIfEnabled: async () => {},
  reconcile: async () => {},
  stop: () => {},
  getStatus: async () => ({ ...DISABLED_STATUS }),
  getServerId: async () => null,
  getPairingCandidate: async () => null,
  ensureEnabledForPairing: async () => null,
});
