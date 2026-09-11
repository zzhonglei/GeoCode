import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KERNEL_BUNDLE_FILENAME, KERNEL_SIDECAR_FILENAME } from './kernel-paths.mjs';

/**
 * Checks what `prepare-geocode-kernel.mjs` actually produced. Skipped when the kernel has
 * not been staged, because staging is a build step rather than a precondition for the
 * unit suites — but never softened when it HAS run, since every failure here is a defect
 * that would only otherwise appear as a dead kernel inside a packaged app.
 */
const stagedDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'kernel');
const staged = fs.existsSync(path.join(stagedDir, KERNEL_BUNDLE_FILENAME));

describe.skipIf(!staged)('staged kernel runtime', () => {
  // Read lazily: `skipIf` skips the tests, not this function body, so anything eager here
  // still runs — and throws — on a tree where the kernel was never staged.
  const bundle = staged ? fs.readFileSync(path.join(stagedDir, KERNEL_BUNDLE_FILENAME), 'utf8') : '';

  it('ships every wasm asset the bundle names', () => {
    // Names are content hashes, so a rebuilt kernel renames them all. A stage that copied
    // the previous build's files would leave the bundle pointing at absent ones, and
    // nothing would say so until a shell tool or an image read failed at runtime.
    const referenced = [...new Set([...bundle.matchAll(/"\.\/([\w.-]+\.wasm)"/g)].map((match) => match[1]))];
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(fs.existsSync(path.join(stagedDir, name))).toBe(true);
    }
  });

  it('stages the two dependencies the bundle declares external and statically imports', () => {
    expect(fs.existsSync(path.join(stagedDir, 'deps', 'jsonc-parser'))).toBe(true);
    expect(fs.existsSync(path.join(stagedDir, 'deps', 'node-pty'))).toBe(true);
  });

  it('stages a platform-specific node-pty, not just the dispatcher', () => {
    const deps = fs.readdirSync(path.join(stagedDir, 'deps'));
    expect(deps.some((name) => /^node-pty-\w+-\w+$/.test(name))).toBe(true);
  });

  it('keeps them out of a node_modules, which electron-builder drops from extraResources', () => {
    // Measured: a `node_modules` here survives the source tree and vanishes from the app,
    // and a `filter` of `**/*` does not override it. The packaged kernel then dies at
    // ERR_MODULE_NOT_FOUND — a failure that only ever appears after packaging.
    expect(fs.existsSync(path.join(stagedDir, 'node_modules'))).toBe(false);
  });

  it('leaves no bare specifier the staged layout cannot resolve', () => {
    for (const specifier of ['"jsonc-parser"', '"@lydell/node-pty"']) {
      expect(bundle.includes(specifier)).toBe(false);
    }
    expect(bundle).toContain('"./deps/jsonc-parser/');
    expect(bundle).toContain('"./deps/node-pty/');
  });

  it('points the node-pty dispatcher at its sibling by file path', () => {
    const dispatcher = fs.readFileSync(path.join(stagedDir, 'deps', 'node-pty', 'index.js'), 'utf8');
    // A bare `require` here would need the node_modules this layout does not have, and
    // `exports` does not apply to relative requires — so it must name the file.
    expect(dispatcher).toMatch(/const PACKAGE_NAME = "\.\.\/node-pty-\w+-\w+\/.+\.js";/);
    const [, relative] = dispatcher.match(/const PACKAGE_NAME = "(\.\.\/[^"]+)";/);
    expect(fs.existsSync(path.join(stagedDir, 'deps', 'node-pty', relative))).toBe(true);
  });

  it('declares module type, without which an ESM bundle named .js loads as CommonJS', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(stagedDir, 'package.json'), 'utf8'));
    expect(manifest.type).toBe('module');
  });

  it('stages the sidecar and the protocol module it imports', () => {
    expect(fs.existsSync(path.join(stagedDir, KERNEL_SIDECAR_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(stagedDir, 'kernel-protocol.mjs'))).toBe(true);
  });

  it('leaves the sourcemap behind: it is a build artifact, and larger than all of this', () => {
    expect(fs.readdirSync(stagedDir).filter((name) => name.endsWith('.map'))).toHaveLength(0);
  });

  it('records what it was built from, so a stale stage can be recognised', () => {
    const stamp = JSON.parse(fs.readFileSync(path.join(stagedDir, 'kernel-stamp.json'), 'utf8'));
    expect(stamp.platform).toBeTruthy();
    expect(stamp.arch).toBeTruthy();
    expect(Array.isArray(stamp.wasm)).toBe(true);
  });
});
