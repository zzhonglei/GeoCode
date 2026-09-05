/* --- GeoCode: user-facing text must name GeoCode's paths, not upstream's
 * (docs/PATHS.md §5, docs/DESKTOP.md §8.1).
 *
 * The behaviour moved in stage 6 and is proven by the write detector and the round trip;
 * the strings that tell the user where to put a theme or where a skill lands did not, and
 * nothing scanned the locale dictionaries because they carry no patch marker. This scans the
 * product languages for upstream path spellings. Surfaces slated for removal under
 * DESKTOP.md §7.3 are exempt by key prefix, not by string, so a new leak elsewhere still fails. --- */
import { describe, expect, test } from 'bun:test';

import { dict as en } from '../lib/i18n/messages/en';
import { dict as zhCN } from '../lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../lib/i18n/messages/zh-TW';

const UPSTREAM_PATH_SPELLINGS = [/\.config\/openchamber/, /\.config\/opencode/, /\.local\/share\/opencode/, /\.opencode\b/, /opencode\.jsonc?\b/, /~\/\.openchamber/];

// Keys under these prefixes belong to surfaces the desktop shell does not offer (§7.3).
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
