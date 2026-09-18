/* --- GeoCode: a merge that takes upstream's side of the unmarked dictionaries must not bring back strings that
 * promise what the shell does not do (docs/DESKTOP.md §5.2, §7.2, §7.3). --- */
import { describe, expect, test } from 'bun:test';

import { dict as en } from '../lib/i18n/messages/en';
import { dict as zhCN } from '../lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../lib/i18n/messages/zh-TW';

type Dictionary = Record<string, string>;

interface Binding {
  behaviour: string;
  keys: string[];
  // What upstream's strings promise and the shell does not do.
  forbidden: RegExp[];
}

const BINDINGS: Binding[] = [
  {
    behaviour: 'applying settings refreshes the kernel; nothing restarts',
    keys: [
      'settings.view.actions.reloadOpenCodeTooltip',
      'settings.view.actions.applyAndRestartOpenCode',
      'settings.view.actions.applyAndRestartOpenCodeTooltipSingle',
      'settings.view.actions.applyAndRestartOpenCodeTooltipPlural',
      'settings.view.pendingRestart.applying',
      'settings.view.pendingRestart.applied',
      'settings.view.pendingRestart.saved',
      'settings.view.pendingRestart.confirm.title',
      'settings.view.pendingRestart.confirm.description',
      'settings.mcp.page.status.label.awaitingRestart',
      'settings.mcp.page.status.description.awaitingRestart',
      'chat.toast.opencodeRestartInterrupted.description',
    ],
    forbidden: [/restart/i, /重启/, /重新啟動/, /重啟/],
  },
  {
    behaviour: 'deleting an MCP server takes effect when changes are applied; the app does not reload',
    keys: ['settings.mcp.page.deleteDialog.descriptionSuffix'],
    forbidden: [/reload/i, /重新加载/, /重新載入/],
  },
  {
    behaviour: 'the update button opens the release page; nothing downloads',
    keys: ['updateDialog.actions.downloadUpdate'],
    forbidden: [/download update/i, /下载更新/, /下載更新/],
  },
  {
    behaviour: 'the desktop section has no network half',
    keys: ['settings.openchamber.desktopNetwork.title'],
    forbidden: [/network/i, /网络/, /網路/],
  },
  {
    behaviour: 'GeoCode is a desktop app on this computer, with no web page, phone or server',
    keys: [
      'settings.integrations.firstParty.info',
      'settings.openchamber.desktopNetwork.field.keepAwakeDescription',
      'settings.voice.page.tooltip.sttLocal',
      'settings.voice.page.tooltip.localTts',
      'settings.voice.page.tooltip.browser',
      'settings.voice.page.tooltip.openai',
      'startup.initRecovery.description',
      'chat.container.sessionLoadError.description',
      'sessions.scheduledTasks.dialog.description',
      'sessions.scheduledTasks.editor.description',
    ],
    forbidden: [/\bweb\b/i, /phone/i, /mobile/i, /server/i, /网页/, /手机/, /移动端/, /服务器/, /服务端/, /網頁/, /手機/, /行動裝置/, /伺服器/],
  },
  {
    behaviour: 'the app is not a browser tab, so no shortcut meets browser defaults',
    keys: ['settings.openchamber.keyboardShortcuts.warning.riskyBrowserShortcut'],
    forbidden: [/browser/i, /浏览器/, /瀏覽器/],
  },
  {
    behaviour: 'the general page has no privacy section in the desktop shell',
    keys: ['settings.page.general.description'],
    forbidden: [/privacy/i, /隐私/, /隱私/],
  },
  {
    behaviour: 'agent memory is not offered',
    keys: ['contextRail.surface.notes.description'],
    forbidden: [/memory/i, /记忆/, /記憶/],
  },
  {
    behaviour: 'sessions are not shared',
    keys: ['settings.openchamber.sessionRetention.tooltip', 'settings.openchamber.sessionRetention.archivedTooltip'],
    forbidden: [/shared/i, /分享/],
  },
  {
    behaviour: 'MCP authorization in the desktop shell has nowhere to paste a callback',
    keys: ['settings.mcp.page.toast.authorizationStillInProgress'],
    forbidden: [/paste/i, /粘贴/, /貼上/],
  },
  {
    behaviour: 'a saved plan is kept with the app, not written into the project folder',
    keys: ['saveProjectPlanDialog.description'],
    forbidden: [/project/i, /项目/, /專案/],
  },
];

const violations = (dictionary: Dictionary) => BINDINGS.flatMap((binding) => binding.keys.flatMap((key) => {
  const value = dictionary[key];
  if (typeof value !== 'string') return [`${key}: missing`];
  return binding.forbidden.some((pattern) => pattern.test(value)) ? [`${key}: ${value}`] : [];
}));

describe('locale strings and shell behaviour', () => {
  test('the product languages describe what the shell does', () => {
    expect(violations(en as Dictionary)).toEqual([]);
    expect(violations(zhCN as Dictionary)).toEqual([]);
    expect(violations(zhTW as Dictionary)).toEqual([]);
  });

  test('upstream wording for each behaviour is caught', () => {
    const upstream: Dictionary = {
      ...(en as Dictionary),
      'settings.view.pendingRestart.saved': 'Saved. Restart OpenCode to apply.',
      'updateDialog.actions.downloadUpdate': 'Download Update',
      'settings.openchamber.desktopNetwork.title': 'Desktop Network Access',
      'chat.toast.opencodeRestartInterrupted.description': 'GeoCode restarted while a response was still running. Send a message to continue.',
      'settings.mcp.page.deleteDialog.descriptionSuffix': 'GeoCode will need to reload.',
      'settings.voice.page.tooltip.sttLocal': 'On-device transcription on the GeoCode server. Models download automatically; no API key needed.',
      'settings.openchamber.keyboardShortcuts.warning.riskyBrowserShortcut': 'This shortcut can conflict with browser defaults. You can still save it.',
      'contextRail.surface.notes.description': 'Notes, todos, plans, and agent memory for the project',
      'settings.openchamber.sessionRetention.tooltip': 'Keeps the open session, running sessions and shared sessions.',
      'settings.mcp.page.toast.authorizationStillInProgress': 'Authorization is still in progress in your browser. Paste the callback URL or code if needed.',
      'saveProjectPlanDialog.description': 'Save this plan into your project as a Markdown file.',
      'settings.page.general.description': 'App startup, security, connection, and privacy.',
    };
    expect(violations(upstream)).toHaveLength(12);
    const upstreamZh: Dictionary = {
      ...(zhCN as Dictionary),
      'settings.mcp.page.status.label.awaitingRestart': '等待重启',
      'updateDialog.actions.downloadUpdate': '下载更新',
      'settings.openchamber.desktopNetwork.title': '桌面端网络访问',
    };
    expect(violations(upstreamZh)).toHaveLength(3);
  });

  test('a key that disappears is a violation, not a pass', () => {
    const { 'updateDialog.actions.downloadUpdate': _dropped, ...rest } = en as Dictionary;
    expect(violations(rest)).toEqual(['updateDialog.actions.downloadUpdate: missing']);
  });
});
