#!/usr/bin/env node
/* --- GeoCode: stages the embedded Agent Kernel into resources/ (docs/DESKTOP.md §4.1).
 *
 * This replaces upstream's `prepare-opencode-cli.mjs`, and the difference is the whole
 * point of the product: that script downloads a released opencode binary pinned by an SDK
 * version, while this one stages OUR kernel from the sibling vendor root. Nothing is
 * fetched from the network, and no component exists that a self-upgrade could replace.
 *
 * What the staged directory has to contain is set by how the bundle was built
 * (`kernel/packages/opencode/script/build-node.ts`), not by preference:
 *
 *   - the four `.wasm` files are named by content hash and resolved beside the bundle,
 *     against `import.meta.url` rather than the working directory;
 *   - `jsonc-parser` and `@lydell/node-pty` are declared external, so they are static
 *     ESM imports the bundle cannot satisfy alone;
 *   - `@lydell/node-pty` is a dispatcher whose real code lives in a per-platform optional
 *     package, so the TARGET platform's package is staged, not the host's;
 *   - `package.json` declaring `"type": "module"` is required for a bundle named `.js`
 *     that is ESM;
 *   - the 53 MB sourcemap is deliberately not copied. It is a build artifact, not a
 *     runtime one, and larger than everything else here combined.
 *
 * ## Why the dependencies are not in a `node_modules`
 *
 * electron-builder drops `node_modules` from `extraResources` unconditionally — a `filter`
 * of `**\/*` does not override it — so a kernel staged the obvious way loads fine from the
 * source tree and then dies at `ERR_MODULE_NOT_FOUND` inside the packaged app. Measured,
 * not assumed: the first `--dir` build produced a `kernel/` with every wasm and no `deps`.
 *
 * So the packages are flattened into `deps/`, which electron-builder has no opinion about,
 * and the bare specifiers are rewritten to relative paths that need no resolution
 * algorithm at all. Every rewrite is asserted below: a bundle whose import shape changed
 * fails the build here rather than shipping an app that cannot start.
 *
 * The sidecar and the protocol module are copied in rather than imported across the asar
 * boundary, which is what lets the staged directory be run and verified on its own. Their
 * single source stays in `geocode/`. --- */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTargetArchitecture } from './target-architecture.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const desktopRoot = path.resolve(electronRoot, '../..');
const repoRoot = path.resolve(desktopRoot, '..');
const kernelRoot = path.join(repoRoot, 'kernel');
const kernelPackage = path.join(kernelRoot, 'packages', 'opencode');
const bundleDir = path.join(kernelPackage, 'dist', 'node');
const outputDir = path.join(electronRoot, 'resources', 'kernel');
const sourceDir = path.join(electronRoot, 'geocode');

const STAGED_SOURCES = ['kernel-sidecar.mjs', 'kernel-protocol.mjs'];
const BUNDLE_FILENAME = 'node.js';
const DEPS_DIRECTORY = 'deps';

const args = process.argv.slice(2);
const force = args.includes('--force');

const log = (message) => console.log(`[geocode-kernel] ${message}`);

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed with status ${result.status}: ${command} ${commandArgs.join(' ')}`);
  }
};

const capture = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true, ...options });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
};

const ensureBundle = () => {
  const bundlePath = path.join(bundleDir, BUNDLE_FILENAME);
  if (fs.existsSync(bundlePath) && !force) {
    log(`reusing existing bundle at ${path.relative(repoRoot, bundlePath)} (pass --force to rebuild)`);
    return bundlePath;
  }
  if (!fs.existsSync(kernelPackage)) {
    throw new Error(`Kernel vendor root is missing at ${kernelPackage}. The desktop build reads it directly.`);
  }
  log('building kernel bundle');
  run('bun', ['run', './script/build-node.ts'], { cwd: kernelPackage });
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Kernel build finished but produced no bundle at ${bundlePath}`);
  }
  return bundlePath;
};

/**
 * Walks up from a resolved entry point to the package directory itself. Bun's store keeps
 * real packages under versioned `.bun/` paths reached through symlinks, so the directory
 * name cannot be assumed from the workspace layout.
 */
const resolvePackage = (name, fromPaths) => {
  const suffix = path.join('node_modules', ...name.split('/'));
  let entry;
  try {
    entry = require.resolve(name, { paths: fromPaths });
  } catch (error) {
    throw new Error(`Cannot resolve ${name} from the kernel vendor root: ${error.message}`);
  }
  let root = path.dirname(entry);
  while (!root.endsWith(suffix)) {
    const parent = path.dirname(root);
    if (parent === root) throw new Error(`Resolved ${name} to ${entry} but found no package root above it`);
    root = parent;
  }
  return { root, entry: path.relative(root, entry) };
};

const stageDependency = (name, directory, fromPaths) => {
  const { root, entry } = resolvePackage(name, fromPaths);
  const to = path.join(outputDir, DEPS_DIRECTORY, directory);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // dereference: the source is reached through a symlink into bun's store, and an
  // installer copying a dangling link into the app produces a kernel that dies at import.
  fs.cpSync(root, to, { recursive: true, dereference: true });
  return { root, specifier: `./${DEPS_DIRECTORY}/${directory}/${entry.split(path.sep).join('/')}` };
};

/** Replaces every occurrence and refuses to continue when there were none. */
const rewrite = (source, from, to, what) => {
  const parts = source.split(from);
  if (parts.length === 1) {
    throw new Error(`Expected to rewrite ${what} but found no occurrence of ${JSON.stringify(from)}`);
  }
  log(`rewrote ${parts.length - 1} × ${what}`);
  return parts.join(to);
};

const main = () => {
  const target = resolveTargetArchitecture({ environment: process.env, builderArgs: args });
  const platform = process.env.OPENCHAMBER_TARGET_PLATFORM || process.platform;
  const nodePtyPlatformPackage = `@lydell/node-pty-${platform}-${target.node}`;
  const nodePtyPlatformDirectory = `node-pty-${platform}-${target.node}`;

  const bundlePath = ensureBundle();

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const wasm = fs.readdirSync(bundleDir).filter((name) => name.endsWith('.wasm'));
  if (wasm.length === 0) throw new Error(`No .wasm files beside ${bundlePath}; the bundle would fail at load`);
  for (const name of wasm) fs.copyFileSync(path.join(bundleDir, name), path.join(outputDir, name));

  for (const name of STAGED_SOURCES) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(outputDir, name));
  }

  const resolveFrom = [kernelPackage, path.join(kernelRoot, 'packages', 'core'), kernelRoot];
  const jsonc = stageDependency('jsonc-parser', 'jsonc-parser', resolveFrom);
  const nodePty = stageDependency('@lydell/node-pty', 'node-pty', resolveFrom);
  const nodePtyPlatform = stageDependency(nodePtyPlatformPackage, nodePtyPlatformDirectory, [nodePty.root, ...resolveFrom]);

  let bundle = fs.readFileSync(bundlePath, 'utf8');
  bundle = rewrite(bundle, '"jsonc-parser"', `"${jsonc.specifier}"`, 'the jsonc-parser specifier');
  bundle = rewrite(bundle, '"@lydell/node-pty"', `"${nodePty.specifier}"`, 'the node-pty specifier');
  fs.writeFileSync(path.join(outputDir, BUNDLE_FILENAME), bundle);

  // The dispatcher builds its platform package name at runtime and `require`s it as a bare
  // specifier, which would need the very node_modules this layout avoids. Point it at the
  // sibling directory instead — by file, because `exports` does not apply to relative
  // requires and the platform package has no `main`.
  const dispatcherPath = path.join(outputDir, DEPS_DIRECTORY, 'node-pty', 'index.js');
  // Both live under deps/, so the dispatcher reaches its sibling by replacing the bundle's
  // `./deps/` prefix with one level up.
  const platformEntry = nodePtyPlatform.specifier.replace(`./${DEPS_DIRECTORY}/`, '../');
  fs.writeFileSync(
    dispatcherPath,
    rewrite(
      fs.readFileSync(dispatcherPath, 'utf8'),
      'const PACKAGE_NAME = `@lydell/node-pty-${process.platform}-${process.arch}`;',
      `const PACKAGE_NAME = ${JSON.stringify(platformEntry)};`,
      'the node-pty platform dispatch',
    ),
  );

  fs.writeFileSync(
    path.join(outputDir, 'package.json'),
    `${JSON.stringify({ name: 'geocode-kernel', private: true, type: 'module' }, null, 2)}\n`,
  );

  // Records what this staging came from, so a stale stage can be recognised without
  // rebuilding to compare.
  fs.writeFileSync(
    path.join(outputDir, 'kernel-stamp.json'),
    `${JSON.stringify({
      kernelTree: capture('git', ['rev-parse', 'HEAD:kernel'], { cwd: repoRoot }) || null,
      kernelDirty: capture('git', ['status', '--porcelain', 'kernel'], { cwd: repoRoot }).length > 0,
      platform,
      arch: target.node,
      nodePtyPackage: nodePtyPlatformPackage,
      wasm: wasm.sort(),
    }, null, 2)}\n`,
  );

  const bytes = fs.readdirSync(outputDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((total, entry) => total + fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size, 0);
  log(`staged ${path.relative(electronRoot, outputDir)} for ${platform}/${target.node} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
};

main();
