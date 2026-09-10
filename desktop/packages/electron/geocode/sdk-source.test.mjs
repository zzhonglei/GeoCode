/* --- GeoCode: the shell talks to the kernel through a client generated from the kernel's own
 * OpenAPI, so the two have to be the same build (docs/DESKTOP.md §4.3).
 *
 * They were not. The shell inherited OpenChamber's pin — a published npm release five patches
 * ahead of the kernel we vendor — because the shell upstream connects to whatever OpenCode the
 * user installed and cannot align with it. GeoCode ships both sides, so it can. The two surfaces
 * happened to be identical when measured (162 paths, 1409 exported types, no difference either
 * way), which is exactly why nothing failed and nothing noticed.
 *
 * The declarations are found by walking the install root and its workspaces rather than by a list
 * kept here: the first pass at this missed the fourth declaration, the one in the install root's
 * own package.json, and a list would have gone on missing it. --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(electronRoot, '../../..');
const desktopRoot = path.resolve(electronRoot, '../..');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const SDK = '@opencode-ai/sdk';
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];

/** Every package.json bun resolves for the desktop install: the root plus its workspace members. */
const manifests = () => {
  const root = path.join(desktopRoot, 'package.json');
  const globs = readJson(root).workspaces ?? [];
  const members = globs.flatMap((glob) => {
    const [dir, star] = glob.split('/');
    if (star !== '*') return [path.join(desktopRoot, glob, 'package.json')];
    return fs.readdirSync(path.join(desktopRoot, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(desktopRoot, dir, entry.name, 'package.json'));
  });
  return [root, ...members].filter((file) => fs.existsSync(file));
};

const declarations = () => manifests().flatMap((file) => FIELDS
  .filter((field) => readJson(file)[field]?.[SDK])
  .map((field) => ({ file: path.relative(repoRoot, file), spec: readJson(file)[field][SDK] })));

const kernelVersion = () => readJson(path.join(repoRoot, 'kernel/packages/opencode/package.json')).version;

describe('kernel and SDK come from one build', () => {
  it('finds the declarations by walking, so a new package cannot slip past', () => {
    // A scan that silently matched nothing would agree with every assertion below.
    expect(manifests().length).toBeGreaterThan(4);
    expect(declarations().length).toBeGreaterThanOrEqual(4);
  });

  it('pins every one of them to the kernel this repository vendors', () => {
    const version = kernelVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(declarations().map(({ file, spec }) => `${file} ${spec}`).sort())
      .toEqual(declarations().map(({ file }) => `${file} ${version}`).sort());
  });

  it('keeps the kernel SDK package on the same number as the kernel', () => {
    // The repository's own generated client, which §4.3 wants the shell on eventually. If these
    // two ever diverge the pin above is aiming at a version the kernel no longer describes.
    expect(readJson(path.join(repoRoot, 'kernel/packages/sdk/js/package.json')).version).toBe(kernelVersion());
  });
});
