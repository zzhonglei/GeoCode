import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';

import { KERNEL_COMMAND } from './kernel-protocol.mjs';
import { createKernelPassword, pickFreePort, startKernelHost } from './kernel-host.mjs';

const createFakeChild = ({ onStart } = {}) => {
  const listeners = new Map();
  const child = {
    sent: [],
    killed: 0,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return child;
    },
    once(event, listener) {
      const wrapper = (...args) => {
        child.off(event, wrapper);
        listener(...args);
      };
      return child.on(event, wrapper);
    },
    off(event, listener) {
      const current = listeners.get(event) ?? [];
      const index = current.indexOf(listener);
      if (index >= 0) current.splice(index, 1);
      return child;
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    postMessage(message) {
      child.sent.push(message);
      onStart?.(child, message);
    },
    kill() {
      child.killed += 1;
    },
  };
  return child;
};

/** Polls rather than counting microtasks, because the host awaits a port probe before it schedules anything. */
const waitUntil = async (predicate, description) => {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
};

const createControlledTimers = () => {
  const pending = new Map();
  let nextId = 0;
  const counts = { created: 0, cleared: 0 };
  const timers = {
    setTimeout: (fn, ms) => {
      const id = ++nextId;
      counts.created += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      if (pending.delete(id)) counts.cleared += 1;
    },
    has: (ms) => [...pending.values()].some((entry) => entry.ms === ms),
    fire: (ms) => {
      for (const [id, entry] of [...pending]) {
        if (entry.ms !== ms) continue;
        pending.delete(id);
        entry.fn();
      }
    },
    fireWhenScheduled: async (ms) => {
      await waitUntil(() => timers.has(ms), `a ${ms}ms timer to be scheduled`);
      timers.fire(ms);
    },
    counts,
    get size() {
      return pending.size;
    },
  };
  return timers;
};

const readyOnStart = (hostname, port) => (child, message) => {
  if (message.type !== KERNEL_COMMAND.START) return;
  child.emit('message', { type: 'ready', hostname, port });
};

const startWith = (child, overrides = {}) => startKernelHost({
  fork: () => child,
  sidecarPath: '/app/kernel/kernel-sidecar.mjs',
  cwd: '/home/user',
  environment: {},
  password: 'test-password',
  health: async () => true,
  pickPort: async () => 51999,
  logger: { info: () => {}, warn: () => {} },
  ...overrides,
});

describe('startKernelHost handshake', () => {
  it('sends a start command and resolves with the address the kernel actually bound', async () => {
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const host = await startWith(child);

    expect(child.sent[0]).toEqual({
      type: KERNEL_COMMAND.START,
      hostname: '127.0.0.1',
      port: 51999,
      password: 'test-password',
    });
    expect(host.connection).toEqual({
      hostname: '127.0.0.1',
      port: 51234,
      baseUrl: 'http://127.0.0.1:51234',
      password: 'test-password',
    });
  });

  it('takes the port the kernel reports over the one it was asked for', async () => {
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 60001) });
    const host = await startWith(child, { port: 4444 });
    expect(host.connection.port).toBe(60001);
  });

  it('never sends 0, which the kernel would read as "prefer 4096" and take a user opencode\'s port', async () => {
    for (const requested of [undefined, 0, -1, 1.5, 'auto']) {
      const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
      await startWith(child, { port: requested });
      expect(child.sent[0].port).toBe(51999);
    }
  });

  it('honours an explicit port without probing for one', async () => {
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 4444) });
    let probes = 0;
    await startWith(child, { port: 4444, pickPort: async () => { probes += 1; return 51999; } });
    expect(child.sent[0].port).toBe(4444);
    expect(probes).toBe(0);
  });

  it('fails with the kernel error message when the kernel reports one', async () => {
    const child = createFakeChild({
      onStart: (c) => c.emit('message', { type: 'error', error: { message: 'port already in use' } }),
    });
    await expect(startWith(child)).rejects.toThrow(/port already in use/);
    expect(child.killed).toBe(1);
  });

  it('fails immediately when the kernel exits before ready, naming the exit code', async () => {
    const child = createFakeChild({ onStart: (c) => c.emit('exit', 9) });
    await expect(startWith(child)).rejects.toThrow(/exited before reporting ready with code 9/);
  });

  it('does not kill a child that already exited on its own', async () => {
    const child = createFakeChild({ onStart: (c) => c.emit('exit', 9) });
    await expect(startWith(child)).rejects.toThrow();
    expect(child.killed).toBe(0);
  });

  it('fails and kills when the kernel stalls past the start deadline', async () => {
    const timers = createControlledTimers();
    const child = createFakeChild();
    const pending = startWith(child, { timers, startTimeoutMs: 60_000 });
    await timers.fireWhenScheduled(60_000);
    await expect(pending).rejects.toThrow(/did not report ready within 60000ms/);
    expect(child.killed).toBe(1);
  });

  it('treats any message as progress: an unrecognised one retires the old deadline for a new one', async () => {
    const timers = createControlledTimers();
    const child = createFakeChild();
    const pending = startWith(child, { timers, startTimeoutMs: 60_000 });
    await waitUntil(() => timers.counts.created === 1, 'the start deadline to be armed');

    child.emit('message', { type: 'loading', progress: 0.5 });
    expect(timers.counts).toEqual({ created: 2, cleared: 1 });

    child.emit('message', { type: 'ready', hostname: '127.0.0.1', port: 51234 });
    expect(await pending).toMatchObject({ connection: { port: 51234 } });
  });
});

describe('startKernelHost stop', () => {
  it('asks before it kills, so the kernel can sweep its own children', async () => {
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const host = await startWith(child);

    const stopping = host.stop();
    expect(child.sent[1]).toEqual({ type: KERNEL_COMMAND.STOP });
    expect(child.killed).toBe(0);

    child.emit('exit', 0);
    await stopping;
    expect(child.killed).toBe(0);
  });

  it('kills when the kernel does not exit within the stop deadline', async () => {
    const timers = createControlledTimers();
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const host = await startWith(child, { timers, stopTimeoutMs: 6_000 });

    const stopping = host.stop();
    await timers.fireWhenScheduled(6_000);
    await stopping;
    expect(child.killed).toBe(1);
  });

  it('is idempotent: a second stop rides the first', async () => {
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const host = await startWith(child);

    const first = host.stop();
    const second = host.stop();
    expect(first).toBe(second);
    expect(child.sent.filter((m) => m.type === KERNEL_COMMAND.STOP)).toHaveLength(1);

    child.emit('exit', 0);
    await first;
  });

  it('resolves without sending anything when the kernel already exited', async () => {
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const host = await startWith(child);
    child.emit('exit', 0);

    await host.stop();
    expect(child.sent.filter((m) => m.type === KERNEL_COMMAND.STOP)).toHaveLength(0);
    expect(host.exited).toBe(true);
    expect(host.exitCode).toBe(0);
  });
});

describe('startKernelHost health', () => {
  it('keeps probing until the kernel answers, not merely until it reported ready', async () => {
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    let answers = 0;
    // Real timers: a controlled one would have to fire a retry the poll may not have scheduled yet.
    const host = await startWith(child, { healthIntervalMs: 1, health: async () => ++answers >= 3 });

    await host.health.wait;
    expect(answers).toBe(3);
  });

  it('rejects when the kernel exits before any probe passes', async () => {
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const host = await startWith(child, { health: async () => false });
    child.emit('exit', 3);
    await expect(host.health.wait).rejects.toThrow(/exited before answering a health check, with code 3/);
  });

  it('leaves no rejection unhandled when nothing awaits it, as in production', async () => {
    const unhandled = [];
    const record = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
      await startWith(child, { health: async () => false });
      child.emit('exit', 3);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });
});

describe('startKernelHost exit', () => {
  it('hands over the exit code of a kernel that goes away after ready', async () => {
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const host = await startWith(child);
    child.emit('exit', 137);
    expect(await host.exit).toBe(137);
  });
});

describe('pickFreePort', () => {
  it('returns a bindable port and releases it again', async () => {
    const port = await pickFreePort({ hostname: '127.0.0.1' });
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);

    // The probe must not leave the port held, or the kernel could not bind the one it was given.
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port }, resolve);
    });
    await new Promise((resolve) => server.close(resolve));
  });

  it('never returns the port a user opencode expects', async () => {
    expect(await pickFreePort({ hostname: '127.0.0.1' })).not.toBe(4096);
  });
});

describe('createKernelPassword', () => {
  it('produces a URL-safe secret with real entropy, fresh every call', () => {
    const password = createKernelPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(createKernelPassword()).not.toBe(password);
  });
});

describe('main.mjs quit path', () => {
  for (const shellFails of [false, true]) it(`waits for kernel STOP after shell shutdown (shell fails: ${shellFails})`, async () => {
    const main = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
    const start = main.indexOf('const shutdownBackgroundServices = ');
    const source = main.slice(start, main.indexOf('\n};\n', start) + 4);
    const timers = createControlledTimers();
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const host = await startWith(child, { timers });
    const state = { kernelHandle: host };
    const shutdown = new Function('state', 'setDesktopKeepAwakeActive', 'shellEnvironmentAbort',
      'loadShellEnv', 'killSidecar', 'shutdownSshSessions', `${source}; return shutdownBackgroundServices;`)(
      state, () => {}, { abort() {} }, async () => {},
      async () => { if (shellFails) throw new Error('shell failure'); }, async () => {},
    );
    let completed = false;
    const pending = shutdown().catch((error) => error).then((result) => { completed = true; return result; });
    await waitUntil(() => child.sent.some((message) => message.type === KERNEL_COMMAND.STOP), 'kernel stop');
    expect(state.kernelHandle).toBeNull();
    expect(child.killed).toBe(0);
    expect(completed).toBe(false);
    child.emit('exit', 0);
    const result = await pending;
    expect(completed).toBe(true);
    expect(state.backgroundShutdownComplete).toBe(true);
    expect(timers.size).toBe(0);
    if (shellFails) expect(result.message).toBe('shell failure');
  });
});
