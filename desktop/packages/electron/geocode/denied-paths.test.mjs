/* --- GeoCode: the credential guard has to move when the credentials move.
 *
 * It did not. `desktop_read_file` refuses a list of paths so that "even our own UI (or a
 * prompt-injected agent) can't read credential stores", and the identity work relocated four
 * credential files into GeoCode's data root while that list went on naming OpenChamber's.
 * Nothing failed, because upstream's entry pointed at a path that never existed either.
 *
 * The module answers that by DERIVING the shell's paths from `resolveShellDataRoot`, which makes
 * "the root moved and the guard did not" structurally impossible rather than merely tested. What
 * still needs a tripwire is the derivation itself — spell those paths out again and the guard goes
 * back to being a copy that can rot — so the last case reads the module's own source. --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { geocodeDeniedSegments } from './denied-paths.mjs';
import { resolveShellDataRoot } from './shell-data-root.mjs';

const HOME = '/Users/tester';

/** The handler's own rule, so this checks what it will actually do rather than what we listed. */
const denies = (absolute) => {
  const relative = path.relative(HOME, absolute).split(path.sep).join('/');
  return geocodeDeniedSegments(HOME).some((segment) => relative === segment || relative.startsWith(`${segment}/`));
};

describe('denied paths', () => {
  it('refuses every credential the shell writes under its data root', () => {
    const root = resolveShellDataRoot(HOME);
    for (const name of ['jwt-secret', 'ui-passkeys.json', 'github-auth.json', 'quota']) {
      expect([name, denies(path.join(root, name))]).toEqual([name, true]);
    }
    // A file inside the quota directory, not just the directory itself.
    expect(denies(path.join(root, 'quota', 'cursor.json'))).toBe(true);
  });

  it('refuses the kernel credential store, which lives under the DATA root and not the config one', () => {
    // `auth/index.ts` composes `Global.Path.data/auth.json` — every provider key the user has
    // authorised. Listing it beside the shell's `.config` paths is the mistake to avoid here.
    expect(denies(path.join(HOME, '.local', 'share', 'GeoCode', 'auth.json'))).toBe(true);
  });

  it('refuses the other products entirely', () => {
    for (const foreign of ['.config/opencode/auth.json', '.local/share/opencode/auth.json',
                           '.opencode/bin/opencode', '.config/openchamber/settings.json']) {
      expect([foreign, denies(path.join(HOME, foreign))]).toEqual([foreign, true]);
    }
  });

  it('leaves the shell data root itself readable', () => {
    // Denying the whole root would take the chat session directories with it, and those hold the
    // user's own files — the panel that opens them goes through this same handler.
    const root = resolveShellDataRoot(HOME);
    expect(denies(root)).toBe(false);
    expect(denies(path.join(root, 'chats', '2026-08-30', 'session-a', 'notes.md'))).toBe(false);
  });

  it('derives the shell paths instead of spelling them out', () => {
    // The value assertions above would pass on a hardcoded list that happens to match today.
    // This is what keeps the guard following the root rather than remembering where it once was.
    const source = fs.readFileSync(new URL('./denied-paths.mjs', import.meta.url).pathname, 'utf8');
    expect(source).toContain('resolveShellDataRoot');
    expect(source).not.toContain('.config/GeoCode');
  });

  it('stays wired into the handler', () => {
    const main = fs.readFileSync(new URL('../main.mjs', import.meta.url).pathname, 'utf8');
    const pushedAt = main.indexOf('DENIED_SEGMENTS.push(...geocodeDeniedSegments(home))');
    const checkedAt = main.indexOf('DENIED_SEGMENTS.some((segment)');
    expect(pushedAt).toBeGreaterThan(-1);
    expect(checkedAt).toBeGreaterThan(pushedAt);
  });
});
