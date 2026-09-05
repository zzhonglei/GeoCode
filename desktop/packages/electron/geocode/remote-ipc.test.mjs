/* --- GeoCode: the main process refuses the Remote Instances commands (docs/DESKTOP.md §7.3).
 *
 * The list is pinned against main.mjs in both directions: every name here must still be a case
 * upstream handles (a renamed command would otherwise be "refused" by a list that no longer
 * matches anything), and the guard must sit before the switch. The connect deep link and the
 * one-time relay settings cleanup are pinned the same way. --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REMOTE_IPC_COMMANDS, REMOTE_IPC_REFUSAL, answerRemoteIpc, isRemoteIpcCommand } from './remote-ipc.mjs';
import { RELAY_SETTING_KEYS, dropRelaySettings, hasRelaySettings } from './loopback-settings.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = fs.readFileSync(path.join(electronRoot, 'main.mjs'), 'utf8');

describe('remote IPC commands', () => {
  it('names every SSH, remote login, probe and host-write command, and nothing that reads', () => {
    for (const command of REMOTE_IPC_COMMANDS) {
      expect(isRemoteIpcCommand(command)).toBe(true);
      expect(mainSource).toContain(`case '${command}':`);
    }
    expect(isRemoteIpcCommand('desktop_hosts_get')).toBe(false);
    expect(isRemoteIpcCommand('desktop_get_launch_at_login')).toBe(false);
    const sshCases = mainSource.match(/case 'desktop_ssh_[a-z_]+':/g) ?? [];
    for (const sshCase of sshCases) {
      expect(isRemoteIpcCommand(sshCase.slice(6, -2))).toBe(true);
    }
  });

  it('answers the start-up reads with nothing and refuses every action', () => {
    expect(answerRemoteIpc('desktop_ssh_instances_get')).toEqual({ instances: [] });
    expect(answerRemoteIpc('desktop_ssh_status')).toEqual([]);
    expect(answerRemoteIpc('desktop_ssh_logs')).toEqual([]);
    for (const command of ['desktop_ssh_connect', 'desktop_ssh_instances_set', 'desktop_ssh_import_hosts', 'desktop_remote_password_login', 'desktop_host_probe', 'desktop_hosts_set']) {
      expect(() => answerRemoteIpc(command)).toThrow(REMOTE_IPC_REFUSAL);
    }
  });

  it('main.mjs answers them before the command switch', () => {
    const guard = mainSource.indexOf(`if (isRemoteIpcCommand(command)) return answerRemoteIpc(command);`);
    const handler = mainSource.indexOf('const handleInvoke = async (browserWindow, command, args = {}) => {');
    const firstSwitch = mainSource.indexOf('switch (command) {', handler);
    expect(handler).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(handler);
    expect(guard).toBeLessThan(firstSwitch);
    expect(REMOTE_IPC_REFUSAL).toMatch(/GeoCode/);
  });

  it('main.mjs drops connect deep links before dispatching them', () => {
    const dispatcher = mainSource.indexOf('const dispatchDeepLink = (link) => {');
    const guard = mainSource.indexOf("if (link.type === 'connect') return;", dispatcher);
    const upstreamBranch = mainSource.indexOf("if (link.type === 'connect') {", dispatcher);
    expect(guard).toBeGreaterThan(dispatcher);
    expect(guard).toBeLessThan(upstreamBranch);
  });
});

describe('relay settings left by an earlier build', () => {
  it('are recognised and removed in place, other keys untouched', () => {
    const settings = { privateRelay: { enabled: true }, relaySigningKey: {}, relayEncryptionKey: {}, themeId: 'x' };
    expect(hasRelaySettings(settings)).toBe(true);
    expect(dropRelaySettings(settings)).toBe(settings);
    expect(settings).toEqual({ themeId: 'x' });
    expect(hasRelaySettings(settings)).toBe(false);
    expect(hasRelaySettings(null)).toBe(false);
    expect(RELAY_SETTING_KEYS).toHaveLength(3);
  });

  it('main.mjs removes them once, only when present, after the loopback strip', () => {
    const strip = mainSource.indexOf('stripRemoteAccessSettings(settings);');
    const drop = mainSource.indexOf('if (hasRelaySettings(settings)) await mutateSettingsRoot((root) => dropRelaySettings(root));');
    expect(drop).toBeGreaterThan(strip);
  });
});
