import { describe, expect, it } from 'bun:test';
import net from 'node:net';

import { KERNEL_COMMAND } from './kernel-protocol.mjs';
import { createKernelPassword, pickFreePort, startKernelHost } from './kernel-host.mjs';

/** A utility process stand-in: same surface main.mjs would hand us, none of the Electron. */
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

/**
 * Waits for a condition instead of for a number of microtasks. The host awaits a port
 * probe before it schedules anything, so any test that assumes "the timer exists by now"
 * silently stops testing the moment an await moves upstream of it.
 */
const waitUntil = async (predicate, description) => {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
};

/** Timers the test advances by hand, so a 60s deadline costs no wall clock. */
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
    /** Fires only once the code under test has actually scheduled it. */
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

    // A message the protocol does not know is still evidence the child is alive.
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
    // Real timers on a 1ms interval rather than controlled ones: driving this by hand
    // would mean firing a retry the poll may not have scheduled yet, and a test that
    // depends on counting microtasks breaks whenever an await moves upstream of it.
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

describe('startKernelHost terminate', () => {
  it('signals synchronously, for the shutdown path that cannot await', async () => {
    const child = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const host = await startWith(child);

    host.terminate();
    expect(child.killed).toBe(1);
    // No stop command: this path is the forcible one, and the kernel sweeps on exit.
    expect(child.sent.filter((m) => m.type === KERNEL_COMMAND.STOP)).toHaveLength(0);
  });

  it('does not signal a kernel that already exited or is stopping', async () => {
    const exitedChild = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const exitedHost = await startWith(exitedChild);
    exitedChild.emit('exit', 0);
    exitedHost.terminate();
    expect(exitedChild.killed).toBe(0);

    const stoppingChild = createFakeChild({ onStart: readyOnStart('127.0.0.1', 51234) });
    const stoppingHost = await startWith(stoppingChild);
    stoppingHost.stop();
    stoppingHost.terminate();
    expect(stoppingChild.killed).toBe(0);
  });
});
