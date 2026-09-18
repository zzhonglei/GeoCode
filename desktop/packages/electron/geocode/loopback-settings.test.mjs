/* --- GeoCode: guards a strip that runs too late, letting upstream bind beyond loopback from the settings file as
 * written (docs/DESKTOP.md §6.1). --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REMOTE_ACCESS_SETTING_KEYS, stripRemoteAccessSettings } from './loopback-settings.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = fs.readFileSync(path.join(electronRoot, 'main.mjs'), 'utf8');

describe('loopback settings', () => {
  it('removes the LAN flag and the UI password in place and keeps everything else', () => {
    const settings = {
      desktopLanAccessEnabled: true,
      desktopUiPassword: 'secret',
      desktopLocalPort: 3000,
      desktopMacMenuBarEnabled: false,
    };
    const returned = stripRemoteAccessSettings(settings);
    expect(returned).toBe(settings);
    expect(settings).toEqual({ desktopLocalPort: 3000, desktopMacMenuBarEnabled: false });
    for (const key of REMOTE_ACCESS_SETTING_KEYS) {
      expect(key in settings).toBe(false);
    }
  });

  it('tolerates a settings root that is not an object', () => {
    expect(stripRemoteAccessSettings(null)).toBeNull();
    expect(stripRemoteAccessSettings(undefined)).toBeUndefined();
  });

  it('main.mjs strips the settings between parsing them and choosing the bind host', () => {
    const parsed = mainSource.indexOf('const settings = readSettingsRoot();\n');
    const stripped = mainSource.indexOf('stripRemoteAccessSettings(settings);');
    const lanRead = mainSource.indexOf('settings.desktopLanAccessEnabled === true');
    const passwordRead = mainSource.indexOf('settings.desktopUiPassword');
    expect(parsed).toBeGreaterThan(-1);
    expect(stripped).toBeGreaterThan(parsed);
    expect(lanRead).toBeGreaterThan(stripped);
    expect(passwordRead).toBeGreaterThan(stripped);
    // A second read site of either key elsewhere in main.mjs would bypass the strip.
    const linesReading = (key) => mainSource.split('\n').filter((line) => line.includes(key)).length;
    expect(linesReading('desktopLanAccessEnabled')).toBe(1);
    expect(linesReading('settings.desktopUiPassword')).toBe(1);
  });
});
