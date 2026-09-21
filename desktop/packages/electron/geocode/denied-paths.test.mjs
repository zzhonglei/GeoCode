/* --- GeoCode: guards `desktop_read_file` leaving a credential readable once its root moves, which nothing else
 * notices (docs/PATHS.md §5). --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { deniesRelativePath, geocodeDeniedSegments } from './denied-paths.mjs';
import { resolveShellDataRoot } from './shell-data-root.mjs';

const HOME = '/Users/tester';

// Upstream's own entries, which the handler denies alongside ours and hands to the same matcher.
const UPSTREAM_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.gpg', '.config/gh', '.config/openchamber/credentials'];

// The real rule, not a copy of it: a copy would have stayed green while the handler compared exactly.
const denies = (absolute) =>
  deniesRelativePath(
    path.relative(HOME, absolute).split(path.sep).join('/'),
    [...UPSTREAM_SEGMENTS, ...geocodeDeniedSegments(HOME)],
  );

describe('denied paths', () => {
  it('refuses every credential the shell writes under its data root', () => {
    const root = resolveShellDataRoot(HOME);
    for (const name of ['jwt-secret', 'ui-passkeys.json', 'github-auth.json', 'quota']) {
      expect([name, denies(path.join(root, name))]).toEqual([name, true]);
    }
    expect(denies(path.join(root, 'quota', 'cursor.json'))).toBe(true);
  });

  it('refuses the kernel credential store, which lives under the DATA root and not the config one', () => {
    expect(denies(path.join(HOME, '.local', 'share', 'GeoCode', 'auth.json'))).toBe(true);
  });

  it('refuses the other products entirely', () => {
    for (const foreign of ['.config/opencode/auth.json', '.local/share/opencode/auth.json',
                           '.opencode/bin/opencode', '.config/openchamber/settings.json']) {
      expect([foreign, denies(path.join(HOME, foreign))]).toEqual([foreign, true]);
    }
  });

  it('leaves the shell data root itself readable', () => {
    // Denying the whole root would also refuse the chat session directories, which hold the user's own files.
    const root = resolveShellDataRoot(HOME);
    expect(denies(root)).toBe(false);
    expect(denies(path.join(root, 'chats', '2026-08-30', 'session-a', 'notes.md'))).toBe(false);
  });

  it('derives the shell paths instead of spelling them out', () => {
    // The value assertions above would also pass on a hardcoded list that matches today's root.
    const source = fs.readFileSync(new URL('./denied-paths.mjs', import.meta.url).pathname, 'utf8');
    expect(source).toContain('resolveShellDataRoot');
    expect(source).not.toContain('.config/GeoCode');
  });

  it('refuses a credential spelled in another case, which the filesystem resolves to the same file', () => {
    // macOS and Windows are case-insensitive by default, so these read the files the cases above deny.
    for (const spelling of ['.local/share/geocode/auth.json', '.LOCAL/SHARE/GEOCODE/AUTH.JSON',
                            '.SSH/id_rsa', '.Config/GH/hosts.yml']) {
      expect([spelling, denies(path.join(HOME, spelling))]).toEqual([spelling, true]);
    }
  });

  it('stays wired into the handler', () => {
    const main = fs.readFileSync(new URL('../main.mjs', import.meta.url).pathname, 'utf8');
    const pushedAt = main.indexOf('DENIED_SEGMENTS.push(...geocodeDeniedSegments(home))');
    const checkedAt = main.indexOf('deniesRelativePath(relNormalized, DENIED_SEGMENTS)');
    expect(pushedAt).toBeGreaterThan(-1);
    expect(checkedAt).toBeGreaterThan(pushedAt);
  });
});
