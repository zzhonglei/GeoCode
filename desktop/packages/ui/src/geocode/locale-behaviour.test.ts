/* --- GeoCode: strings that describe a behaviour the shell changed must not describe
 * upstream's (docs/DESKTOP.md §5.2, §7.2, §7.3).
 *
 * Three behaviours differ from upstream and each has strings that name it: applying settings
 * refreshes the embedded kernel instead of restarting a process; the update button opens the
 * release page instead of downloading; the desktop section has no network half. The
 * dictionaries carry no patch marker, so a merge that takes upstream's side reverts the strings
 * silently and every other test stays green. This asserts the consequence, never the wording:
 * a string may say anything except the thing the shell no longer does. --- */
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
    ],
    forbidden: [/restart/i, /重启/, /重新啟動/, /重啟/],
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
    };
    expect(violations(upstream)).toHaveLength(3);
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
