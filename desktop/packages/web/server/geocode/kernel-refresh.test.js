/* --- GeoCode: applying configuration under Electron refreshes the embedded kernel instead of
 * answering with upstream's manual-restart result (docs/DESKTOP.md §5.2). --- */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// execFile too: managed-process-registry.js promisifies it at import.
vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn(), execFile: vi.fn() }));
vi.mock('../lib/opencode/startup-performance.js', () => ({ recordStartupPerformance: vi.fn() }));

const { createOpenCodeLifecycleRuntime } = await import('../lib/opencode/lifecycle.js');

const originalElectron = process.versions.electron;
const originalFetch = globalThis.fetch;
let requests = [];

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  requests = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ url: String(url), method, headers: init.headers ?? {} });
    if (String(url).endsWith('/global/dispose')) return jsonResponse(200, true);
    return jsonResponse(200, { healthy: true });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const createRuntime = ({ getActiveSessionCount = () => 0 } = {}) => {
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    openCodePort: 45678,
    openCodeBaseUrl: 'http://127.0.0.1:45678',
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    lastOpenCodeHealthFailure: null,
    lastManagedOpenCodeProcess: null,
    lastOpenCodeRestartDiagnostics: null,
    isOpenCodeReady: true,
    openCodeNotReadySince: 0,
    isExternalOpenCode: true,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
  };
  const onOpenCodeRestarted = vi.fn();
  const runtime = createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: true,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic dGVzdA==' }),
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
    getActiveSessionCount,
    onOpenCodeRestarted,
  });
  return { runtime, state, onOpenCodeRestarted };
};

const disposeRequests = () => requests.filter((request) => request.url.endsWith('/global/dispose'));

describe('applying configuration to the embedded kernel', () => {
  it('under Electron, disposes the kernel and reports a reload', async () => {
    process.versions.electron = '0.0.0-test';
    const { runtime, onOpenCodeRestarted } = createRuntime();

    const result = await runtime.refreshOpenCodeAfterConfigChange('test');

    expect(result).toEqual({ reloaded: true, external: false });
    const dispose = disposeRequests();
    expect(dispose).toHaveLength(1);
    expect(dispose[0].method).toBe('POST');
    expect(dispose[0].headers.Authorization).toBe('Basic dGVzdA==');
    expect(onOpenCodeRestarted).toHaveBeenCalledTimes(1);
  });

  it('control: the same runtime outside Electron keeps the honest manual-restart answer', async () => {
    delete process.versions.electron;
    const { runtime, onOpenCodeRestarted } = createRuntime();

    const result = await runtime.refreshOpenCodeAfterConfigChange('test');

    expect(result).toEqual({ reloaded: false, external: true });
    expect(disposeRequests()).toHaveLength(0);
    expect(onOpenCodeRestarted).not.toHaveBeenCalled();
  });

  it('refuses while chats are running, before touching the kernel', async () => {
    process.versions.electron = '0.0.0-test';
    const { runtime, onOpenCodeRestarted } = createRuntime({ getActiveSessionCount: () => 2 });

    await expect(runtime.refreshOpenCodeAfterConfigChange('test')).rejects.toThrow(/2 chats are still running/);
    expect(disposeRequests()).toHaveLength(0);
    expect(onOpenCodeRestarted).not.toHaveBeenCalled();
  });

  it('surfaces a kernel that refuses the dispose instead of claiming a reload', async () => {
    process.versions.electron = '0.0.0-test';
    globalThis.fetch = vi.fn(async (url) => (
      String(url).endsWith('/global/dispose') ? jsonResponse(500, null) : jsonResponse(200, { healthy: true })
    ));
    const { runtime, onOpenCodeRestarted } = createRuntime();

    await expect(runtime.refreshOpenCodeAfterConfigChange('test')).rejects.toThrow(/HTTP 500/);
    expect(onOpenCodeRestarted).not.toHaveBeenCalled();
  });
});
