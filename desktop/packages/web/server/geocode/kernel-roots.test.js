/* --- GeoCode: the shell reaches the kernel's files, never OpenCode's (docs/PATHS.md §5). Guards against the
 * hand-copied base names drifting from `core/src/brand.ts`, and against a reader and a writer disagreeing on a
 * path. Consumers are imported inside the tests, after the redirect, as they resolve their paths at import. --- */
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
  // HOME too, so a regression that falls back to the home directory writes into a temporary one.
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
    expect(kernelDataRoot().startsWith(dataHome)).toBe(true);
    expect(kernelDataRoot().startsWith(fakeHome)).toBe(false);
  });

  it('completes an auth round trip inside the kernel data root', async () => {
    const { readAuthFile, writeAuthFile } = await import('../lib/opencode/auth.js');
    const entry = { type: 'api', key: 'geocode-round-trip' };

    writeAuthFile({ 'geocode-test-provider': entry });
    expect(readAuthFile()).toMatchObject({ 'geocode-test-provider': entry });

    // A second write, because only overwriting leaves the backup copy.
    writeAuthFile({ 'geocode-test-provider': entry, other: entry });

    const root = path.join(dataHome, brand().dirName);
    expect(fs.existsSync(path.join(root, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, `auth.json${CONFIG_BACKUP_SUFFIX}`))).toBe(true);
  });

  it('writes config where the kernel reads it', async () => {
    const shared = await import('../lib/opencode/shared.js');
    shared.writeConfig({ model: 'geocode/round-trip' });

    expect(fs.existsSync(path.join(configHome, brand().dirName, 'config.json'))).toBe(true);
    expect(shared.readConfigLayers().mergedConfig.model).toBe('geocode/round-trip');
  });

  it('saves the global behaviour prompt where the kernel loads instructions from', async () => {
    // Both ends, because only the pair is the invariant.
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
    // `mcp.js` builds its project path itself rather than from the config layers, so the two can name different files.
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

  it('looks for antigravity accounts only under the kernel roots', async () => {
    const { ANTIGRAVITY_ACCOUNTS_PATHS } = await import('../lib/quota/utils/auth.js');
    const roots = [kernelConfigRoot(), kernelDataRoot()];
    for (const file of ANTIGRAVITY_ACCOUNTS_PATHS) {
      expect([file, roots.some((root) => file.startsWith(root + path.sep))]).toEqual([file, true]);
    }
  });
});
