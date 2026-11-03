import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from '../lib/notifications/runtime.js';

// Guards against a notification reaching the web push or APNs senders, whatever subscriptions are on disk: the closed
// subscription endpoints only keep new ones from being made.
describe('GeoCode: no push', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a finished turn's notification to the system alone", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
    const emitDesktopNotification = vi.fn(() => true);
    const sendPushToAllUiSessions = vi.fn(async () => undefined);
    const sendApnsToAllUiSessions = vi.fn(async () => undefined);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true }),
      prepareNotificationLastMessage: async ({ message }) => message,
      buildTemplateVariables: async () => ({}),
      extractLastMessageText: () => 'done',
      fetchLastAssistantMessageText: async () => 'done',
      resolveNotificationTemplate: () => '',
      shouldApplyResolvedTemplateMessage: () => false,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions,
      sendApnsToAllUiSessions,
      // Away from the app, where upstream sends to phones as well.
      isAnyInteractiveClientVisible: () => false,
      buildOpenCodeUrl: (path) => `http://kernel.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      readSessionMetadata: async () => ({}),
    });

    const info = { id: 'msg_1', sessionID: 'ses_1', role: 'assistant', agent: 'build', providerID: 'p', modelID: 'm', time: { created: 1 } };
    await runtime.maybeSendPushForTrigger({ type: 'message.updated', properties: { sessionID: 'ses_1', info } });
    await runtime.maybeSendPushForTrigger({ type: 'session.idle', properties: { sessionID: 'ses_1' } });

    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });
});
