/* --- GeoCode: what createRelayService returns under Electron; it keeps every method of upstream's service,
 * and none reaches the network, the disk or the router (docs/DESKTOP.md §6.1, §7.3). --- */

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
