/* --- GeoCode: the shell reaches the kernel's files, never OpenCode's (docs/PATHS.md §3.1).
 *
 * Two different failures need two different shapes here.
 *
 * The base strings in `kernel-roots.js` are a hand-copy of `core/src/brand.ts`, which the
 * shell cannot import: `web` is a dependency of `electron` and not the reverse, and the
 * kernel is a separate install root. Nothing conflicts and nothing fails when a copy drifts
 * from its original — CONVENTIONS.md §5 calls that the case a tripwire exists for — so
 * brand.ts is read as text and compared.
 *
 * The rest is a round trip. A computed path asserted against a literal would still pass with
 * both the writing and the reading side left pointing into OpenCode's directory; only writing
 * a file and finding it under the root we configured shows the two agree. It also exercises
 * the timing: `auth.js` resolves its path once at import, so the environment has to be in
 * place before the module is loaded, exactly as it is in the product. --- */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KERNEL_PROJECT_MARKER, kernelConfigRoot, kernelDataRoot } from './kernel-roots.js';
import { CONFIG_BACKUP_SUFFIX } from './config-backup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.dirname(here);
const BRAND_SOURCE = path.resolve(here, '../../../../../kernel/packages/core/src/brand.ts');
const PATCHED = ['lib/opencode/auth.js', 'lib/quota/utils/auth.js', 'lib/git/service.js'];

const brand = () => {
  const source = fs.readFileSync(BRAND_SOURCE, 'utf8');
  const read = (field) => source.match(new RegExp(`const ${field} = "([^"]+)"`))?.[1];
  return { dirName: read('dirName'), name: read('name') };
};

let dataHome;
let configHome;
let fakeHome;
const saved = {};

beforeAll(() => {
  dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-kernel-data-'));
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-kernel-config-'));
  // Redirected as well, so a regression that falls back to the home directory writes into a
  // temporary one instead of the developer's real `~/.local/share` — measured on this suite's
  // predecessor, which left a directory behind while being mutation-tested.
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-kernel-home-'));
  for (const key of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'HOME']) saved[key] = process.env[key];
  process.env.XDG_DATA_HOME = dataHome;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.HOME = fakeHome;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [dataHome, configHome, fakeHome]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('kernel roots', () => {
  it('names the same directories the kernel brands', () => {
    const { dirName, name } = brand();
    expect(dirName).toBeTruthy();
    expect(kernelDataRoot()).toBe(path.join(dataHome, dirName));
    expect(kernelConfigRoot()).toBe(path.join(configHome, dirName));
    expect(KERNEL_PROJECT_MARKER).toBe(name);
  });

  it('follows XDG, so the shell and the kernel cannot resolve different files', () => {
    // The kernel takes its roots from `xdg-basedir`. Two of the call sites patched here read
    // the home directory instead, which agrees with the kernel only while these are unset.
    expect(kernelDataRoot().startsWith(dataHome)).toBe(true);
    expect(kernelDataRoot().startsWith(fakeHome)).toBe(false);
  });

  it('completes an auth round trip inside the kernel data root', async () => {
    const { readAuthFile, writeAuthFile } = await import('../lib/opencode/auth.js');
    const entry = { type: 'api', key: 'geocode-round-trip' };

    writeAuthFile({ 'geocode-test-provider': entry });
    expect(readAuthFile()).toMatchObject({ 'geocode-test-provider': entry });

    // Written twice on purpose: the second write is the one that copies the previous file
    // aside. That backup is the sharpest form of the harm — before this patch it duplicated
    // the user's real OpenCode credentials into a file OpenCode never made.
    writeAuthFile({ 'geocode-test-provider': entry, other: entry });

    const root = path.join(dataHome, brand().dirName);
    expect(fs.existsSync(path.join(root, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, `auth.json${CONFIG_BACKUP_SUFFIX}`))).toBe(true);
  });

  it('writes config where the kernel reads it', async () => {
    // The layer this guards is the one that read the user's real provider keys, and whose
    // `writeConfig` copied the file it was overwriting to `<name>.openchamber.backup` first.
    const shared = await import('../lib/opencode/shared.js');
    shared.writeConfig({ model: 'geocode/round-trip' });

    expect(fs.existsSync(path.join(configHome, brand().dirName, 'config.json'))).toBe(true);
    expect(shared.readConfigLayers().mergedConfig.model).toBe('geocode/round-trip');
  });

  it('saves the global behaviour prompt where the kernel loads instructions from', async () => {
    // Both ends, because only the pair is the invariant. `routes.js` wrote
    // `~/.config/opencode/AGENTS.md` while `session/instruction.ts` read `<config root>/AGENTS.md`,
    // so the Behavior page reported success and the agent never saw a word of it — and the PUT
    // creates the parent directory, so saving one also created OpenCode's config root.
    //
    // The route joins onto `shared.js`'s OPENCODE_CONFIG_DIR, the single constant upstream now
    // routes every reader of the config root through and the one GeoCode patches. Assert its
    // value rather than how the route spells it: standing the whole route up needs the
    // dependency object the server assembles, but the root the route lands in is a value.
    const { OPENCODE_CONFIG_DIR } = await import('../lib/opencode/shared.js');
    expect(path.join(OPENCODE_CONFIG_DIR, 'AGENTS.md'))
      .toBe(path.join(configHome, brand().dirName, 'AGENTS.md'));

    const shell = fs.readFileSync(path.join(serverRoot, 'lib/opencode/routes.js'), 'utf8');
    expect(shell).toContain("'AGENTS.md'");
    expect(shell).not.toContain("'.config', 'opencode'");

    const kernel = fs.readFileSync(
      path.resolve(here, '../../../../../kernel/packages/opencode/src/session/instruction.ts'), 'utf8');
    expect(kernel).toContain('path.join(global.config, "AGENTS.md")');
  });

  it('adds a project MCP server to the file the config loader reads back', async () => {
    // The accident PATHS.md §5 records by name: `mcp add` wrote one file name while the loader
    // read another, so the command reported success and the server never appeared. `mcp.js`
    // builds its project path itself instead of taking it from the layers, so renaming the
    // reader alone recreates it — measured, while reviewing this very batch.
    const mcp = await import('../lib/opencode/mcp.js');
    const shared = await import('../lib/opencode/shared.js');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-mcp-round-trip-'));

    try {
      mcp.createMcpConfig('probe', { type: 'local', command: ['true'] }, project, 'project');
      expect(shared.readConfigLayers(project).mergedConfig.mcp).toHaveProperty('probe');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('manages skills in the kernel\'s directories and not in OpenCode\'s', async () => {
    // `~/.opencode` is the second global root the kernel deletes rather than renames, so
    // nothing there is ours to rename either. `.claude` and `.agents` are other tools' libraries
    // rather than a root of ours, and have their own tests in external-skills.test.js.
    const { isManagedSkillPath } = await import('../lib/opencode/skills.js');
    const { KERNEL_PROJECT_DIR } = await import('./kernel-roots.js');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-managed-roots-'));

    try {
      expect(isManagedSkillPath(path.join(project, KERNEL_PROJECT_DIR, 'skills', 'x', 'SKILL.md'), project)).toBe(true);
      expect(isManagedSkillPath(path.join(project, '.opencode', 'skills', 'x', 'SKILL.md'), project)).toBe(false);
      expect(isManagedSkillPath(path.join(fakeHome, '.opencode', 'skills', 'x', 'SKILL.md'), project)).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('leaves no call site computing an OpenCode path', () => {
    // Guards the merge that restores one of the three literals. They are separate files with
    // no shared symbol upstream, so nothing but this notices when one comes back.
    for (const file of PATCHED) {
      expect(fs.readFileSync(path.join(serverRoot, file), 'utf8')).not.toContain("'opencode'");
    }
  });
});
