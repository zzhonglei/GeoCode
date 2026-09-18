#!/usr/bin/env node
/* --- GeoCode: stages the kernel built from kernel/ into resources/kernel, in place of upstream's download of a
 * released opencode (docs/DESKTOP.md §4.1). The layout follows kernel/packages/opencode/script/build-node.ts, and
 * each rewrite throws when it matches nothing, so a changed bundle fails here rather than at launch. --- */

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

const STAGED_SOURCES = ['kernel-sidecar.mjs', 'kernel-protocol.mjs']; // copied from geocode/, their only source
const BUNDLE_FILENAME = 'node.js';
const DEPS_DIRECTORY = 'deps'; // not node_modules, which electron-builder drops from extraResources

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

const stampPath = path.join(outputDir, 'kernel-stamp.json');
const currentKernelTree = () => capture('git', ['rev-parse', 'HEAD:kernel'], { cwd: repoRoot }) || null;
const kernelTreeDirty = () => capture('git', ['status', '--porcelain', 'kernel'], { cwd: repoRoot }).length > 0;

// Null only when the stage came from the checked-out kernel tree with no uncommitted kernel changes then or now;
// otherwise the reason to rebuild.
const staleReason = () => {
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch {
    return 'no stamp for the staged kernel';
  }
  if (!stamp.kernelTree) return 'the staged kernel has no tree hash';
  if (stamp.kernelTree !== currentKernelTree()) return `the kernel tree moved since the stage (${stamp.kernelTree.slice(0, 12)} -> ${(currentKernelTree() || '?').slice(0, 12)})`;
  if (stamp.kernelDirty) return 'the staged kernel was built from uncommitted changes';
  if (kernelTreeDirty()) return 'the kernel tree has uncommitted changes';
  return null;
};

const ensureBundle = () => {
  const bundlePath = path.join(bundleDir, BUNDLE_FILENAME);
  const stale = fs.existsSync(bundlePath) ? staleReason() : 'no bundle yet';
  if (fs.existsSync(bundlePath) && !force && !stale) {
    log(`reusing existing bundle at ${path.relative(repoRoot, bundlePath)} (pass --force to rebuild)`);
    return bundlePath;
  }
  if (!force && stale) log(`rebuilding: ${stale}`);
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

/** Walks up from the resolved entry, because bun's store keeps packages under versioned `.bun/` paths. */
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
  // Dereferenced: the source is a symlink into bun's store, and a dangling link in the app kills the kernel at import.
  fs.cpSync(root, to, { recursive: true, dereference: true });
  return { root, specifier: `./${DEPS_DIRECTORY}/${directory}/${entry.split(path.sep).join('/')}` };
};

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

  // The dispatcher `require`s its platform package by a bare name, which needs a node_modules; point it at the
  // sibling by file, because `exports` does not apply to relative requires.
  const dispatcherPath = path.join(outputDir, DEPS_DIRECTORY, 'node-pty', 'index.js');
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

  fs.writeFileSync(
    stampPath,
    `${JSON.stringify({
      // The same two readings staleReason compares against.
      kernelTree: currentKernelTree(),
      kernelDirty: kernelTreeDirty(),
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
