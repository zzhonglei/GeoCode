/* --- GeoCode: the shell runtime never starts a kernel of its own under Electron
 * (docs/ENVIRONMENT.md §5.6). --- */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// The control run registers its fake child in the managed-process registry, which defaults to the real home.
const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-managed-kernel-test-'));
const originalRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = registryDir;
afterAll(() => {
  if (originalRegistry === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = originalRegistry;
  fs.rmSync(registryDir, { recursive: true, force: true });
});

const spawnMock = vi.fn();
// execFile too: managed-process-registry.js promisifies it at import.
vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn(), execFile: vi.fn() }));
vi.mock('../lib/opencode/startup-performance.js', () => ({ recordStartupPerformance: vi.fn() }));

const { createOpenCodeLifecycleRuntime } = await import('../lib/opencode/lifecycle.js');

const originalElectron = process.versions.electron;
afterEach(() => {
  spawnMock.mockReset();
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const listeningChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => true);
  queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
  return child;
};

const createRuntime = () => {
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    lastOpenCodeHealthFailure: null,
    lastManagedOpenCodeProcess: null,
    lastOpenCodeRestartDiagnostics: null,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
  };
  return createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    applyOpencodeBinaryFromSettings: vi.fn(async () => null),
    ensureOpencodeCliEnv: vi.fn(),
    ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
    resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
    setOpenCodePort: vi.fn((port) => { state.openCodePort = port; }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    clearResolvedOpenCodeBinary: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/usr/bin'),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({ PATH: '/usr/bin' })),
  });
};

describe('managed kernel start', () => {
  it('is refused under Electron before any binary is looked for', async () => {
    process.versions.electron = '0.0.0-test';
    const runtime = createRuntime();
    await expect(runtime.startOpenCode()).rejects.toThrow(/owns its kernel/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('control: the same runtime outside Electron does reach spawn', async () => {
    delete process.versions.electron;
    spawnMock.mockImplementationOnce(listeningChild);
    const runtime = createRuntime();
    await runtime.startOpenCode();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
