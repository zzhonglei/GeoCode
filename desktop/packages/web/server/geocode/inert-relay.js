// The relay service's interface without a relay: no identity, no connection, no routes.
export const createInertRelayService = () => ({
  registerRoutes: () => {},
  startIfEnabled: async () => {},
  reconcile: async () => {},
  stop: async () => {},
  getStatus: async () => ({ enabled: false, state: 'disabled', serverId: null, connectedClients: 0, relayUrl: null, relayUrlLocked: false }),
  getServerId: async () => null,
  getPairingCandidate: async () => null,
  ensureEnabledForPairing: async () => null,
});
