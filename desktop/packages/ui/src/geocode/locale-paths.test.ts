/* --- GeoCode: a merge that takes upstream's side of the unmarked dictionaries must not bring back upstream's paths
 * in the strings that tell the user where files go (docs/PATHS.md §5, docs/DESKTOP.md §8.1). --- */
import { describe, expect, test } from 'bun:test';

import { dict as en } from '../lib/i18n/messages/en';
import { dict as zhCN } from '../lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../lib/i18n/messages/zh-TW';

const UPSTREAM_PATH_SPELLINGS = [/\.config\/openchamber/, /\.config\/opencode/, /\.local\/share\/opencode/, /\.opencode\b/, /opencode\.jsonc?\b/, /~\/\.openchamber/];

// Keys under these prefixes belong to surfaces the desktop shell does not offer (docs/DESKTOP.md §7.3).
const EXEMPT_PREFIXES = ['settings.openchamber.opencodeCli.', 'settings.openchamber.tunnel.'];

const leaks = (dictionary: Record<string, string>) => Object.entries(dictionary)
  .filter(([key]) => !EXEMPT_PREFIXES.some((prefix) => key.startsWith(prefix)))
  .filter(([, value]) => UPSTREAM_PATH_SPELLINGS.some((pattern) => pattern.test(value)))
  .map(([key, value]) => `${key}: ${value}`);

describe('locale strings and paths', () => {
  test('the product languages do not name upstream paths', () => {
    expect(leaks(en)).toEqual([]);
    expect(leaks(zhCN)).toEqual([]);
    expect(leaks(zhTW)).toEqual([]);
  });

  test('the scan sees a leak when there is one', () => {
    expect(leaks({ 'x.y': 'Put themes in ~/.config/openchamber/themes/' })).toHaveLength(1);
    expect(leaks({ 'settings.openchamber.tunnel.x': '~/.config/openchamber/cloudflared' })).toHaveLength(0);
  });
});
