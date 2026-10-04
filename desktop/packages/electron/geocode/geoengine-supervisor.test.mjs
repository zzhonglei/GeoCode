import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createSupervisor } from './geoengine-supervisor.mjs';

// Stands in for Electron's UtilityProcess: records what the main process sends and lets a test answer.
class FakeEngine extends EventEmitter {
  posted = [];
  killed = false;
  stderr = new PassThrough();
  // Like the real engine, unless a test drives the sweep itself.
  confirmsShutdown = true;

  postMessage(message) {
    this.posted.push(structuredClone(message));
    if (message.type === 'shutdown' && this.confirmsShutdown) setImmediate(() => this.answer({ type: 'shutdown-complete' }));
  }

  kill() {
    this.killed = true;
    setImmediate(() => this.die(0));
  }

  die(code) {
    this.stderr.end();
    this.emit('exit', code);
  }

  answer(message) {
    this.emit('message', message);
  }

  sent(type) {
    return this.posted.filter((message) => message.type === type);
  }
}

const quiet = { error() {}, warn() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (predicate) => {
  for (let waited = 0; waited < 2000 && !predicate(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
};

const supervise = (options = {}) => {
  const engine = new FakeEngine();
  const kills = [];
  const failures = [];
  const supervisor = createSupervisor({
    fork: () => engine,
    // A graceful kill hands back what forces it, as the real one does on POSIX.
    killTree: (pid, { force }) => {
      kills.push({ pid, force });
      return force ? undefined : () => kills.push({ pid, force: true });
    },
    onFailure: (failure) => failures.push(failure),
    log: quiet,
    ...options,
  });
  return { engine, kills, failures, supervisor };
};

test('requests made before the engine is ready wait for it and go out in order', async () => {
  const { engine, supervisor } = supervise();
  supervisor.start();
  const first = supervisor.request('probe.echo', { n: 1 });
  const second = supervisor.request('probe.echo');
  assert.deepEqual(engine.sent('request'), []);

  engine.answer({ type: 'ready' });
  const sent = engine.sent('request');
  assert.deepEqual(sent.map((message) => message.method), ['probe.echo', 'probe.echo']);
  assert.ok(sent[1].id > sent[0].id);
  assert.equal('params' in sent[1], false);

  engine.answer({ type: 'response', id: sent[1].id, cancelled: false, ok: true, result: 'two' });
  engine.answer({ type: 'response', id: sent[0].id, cancelled: false, ok: true, result: 'one' });
  assert.equal((await first).result, 'one');
  assert.equal((await second).result, 'two');
  await supervisor.shutdown();
});

test('progress reaches the request it belongs to', async () => {
  const { engine, supervisor } = supervise();
  supervisor.start();
  engine.answer({ type: 'ready' });
  const progress = [];
  const response = supervisor.request('probe.ticks', undefined, { onProgress: (data) => progress.push(data) });
  const { id } = engine.sent('request')[0];
  engine.answer({ type: 'progress', id, data: 1 });
  engine.answer({ type: 'progress', id: id + 1, data: 'someone else' });
  engine.answer({ type: 'progress', id, data: 2 });
  engine.answer({ type: 'response', id, cancelled: false, ok: true, result: null });
  await response;
  assert.deepEqual(progress, [1, 2]);
  await supervisor.shutdown();
});

test('a cancel before the engine is ready answers at once and never reaches the engine', async () => {
  const { engine, supervisor } = supervise();
  supervisor.start();
  const controller = new AbortController();
  const response = supervisor.request('probe.wait', undefined, { signal: controller.signal });
  controller.abort();
  const answered = await response;
  assert.equal(answered.cancelled, true);
  assert.equal(answered.ok, false);

  engine.answer({ type: 'ready' });
  assert.deepEqual(engine.sent('request'), []);
  assert.deepEqual(engine.sent('cancel'), []);
  await supervisor.shutdown();
});

test('a cancel after the request went out is passed to the engine, which answers it', async () => {
  const { engine, supervisor } = supervise();
  supervisor.start();
  engine.answer({ type: 'ready' });
  const controller = new AbortController();
  const response = supervisor.request('probe.wait', undefined, { signal: controller.signal });
  const { id } = engine.sent('request')[0];
  controller.abort();
  assert.deepEqual(engine.sent('cancel'), [{ type: 'cancel', id }]);
  engine.answer({ type: 'response', id, cancelled: true, ok: false, error: { code: 'aborted', message: 'stopped' } });
  assert.equal((await response).cancelled, true);
  await supervisor.shutdown();
});

test('an engine that dies on its own fails what was pending, ends its tasks and reports why', async () => {
  const { engine, kills, failures, supervisor } = supervise();
  supervisor.start();
  engine.answer({ type: 'ready' });
  engine.answer({ type: 'task', event: 'start', pid: 101 });
  engine.answer({ type: 'task', event: 'start', pid: 102 });
  engine.answer({ type: 'task', event: 'end', pid: 102 });
  const pending = supervisor.request('probe.wait');
  engine.stderr.write('FATAL ERROR: heap out of memory\n');
  engine.die(134);

  await assert.rejects(pending);
  assert.deepEqual(kills, [{ pid: 101, force: false }]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'exit');
  assert.equal(failures[0].exitCode, 134);
  assert.match(failures[0].output, /heap out of memory/);
  assert.equal(supervisor.phase(), 'failed');
  assert.deepEqual(supervisor.failure(), failures[0]);
  await assert.rejects(supervisor.request('probe.echo'));
});

test('an engine that exits before it is ready failed to start', async () => {
  const { engine, failures, supervisor } = supervise();
  supervisor.start();
  engine.die(1);
  await until(() => failures.length > 0);
  assert.equal(failures[0].reason, 'start');
});

test('error output that arrives after the exit still reaches the failure, characters intact', async () => {
  const { engine, failures, supervisor } = supervise();
  supervisor.start();
  engine.answer({ type: 'ready' });
  engine.emit('exit', 1);
  await tick();
  const words = Buffer.from('路径不存在\n');
  engine.stderr.write(words.subarray(0, 4));
  engine.stderr.write(words.subarray(4));
  engine.stderr.end();
  await until(() => failures.length > 0);
  assert.equal(failures[0].output, '路径不存在');
});

test('a task given a grace period after a crash is forced when the app quits', async () => {
  const { engine, kills, failures, supervisor } = supervise();
  supervisor.start();
  engine.answer({ type: 'ready' });
  engine.answer({ type: 'task', event: 'start', pid: 501 });
  engine.die(1);
  await until(() => failures.length > 0);
  assert.deepEqual(kills, [{ pid: 501, force: false }]);
  await supervisor.shutdown();
  assert.deepEqual(kills, [{ pid: 501, force: false }, { pid: 501, force: true }]);
});

test('messages that arrive after the exit are ignored', async () => {
  const { engine, kills, failures, supervisor } = supervise();
  supervisor.start();
  engine.answer({ type: 'ready' });
  engine.die(1);
  engine.answer({ type: 'task', event: 'start', pid: 601 });
  await until(() => failures.length > 0);
  await supervisor.shutdown();
  assert.deepEqual(kills, []);
});

test('an engine that never becomes ready is ended and reported', async () => {
  const { engine, failures, supervisor } = supervise({ readyTimeoutMs: 50 });
  supervisor.start();
  const pending = supervisor.request('probe.echo');
  await assert.rejects(pending);
  assert.equal(engine.killed, true);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'start');
  await tick();
  assert.equal(failures.length, 1);
});

test('an engine missing from the installation is reported as missing', () => {
  const failures = [];
  const supervisor = createSupervisor({
    fork: () => {
      throw Object.assign(new Error('GeoEngine is missing'), { code: 'ENOENT' });
    },
    killTree: () => assert.fail('nothing was started'),
    onFailure: (failure) => failures.push(failure),
    log: quiet,
  });
  supervisor.start();
  assert.equal(failures[0].reason, 'missing');
});

test('shutdown waits for the engine to finish its sweep, and its exit is not a failure', async () => {
  const { engine, kills, failures, supervisor } = supervise();
  engine.confirmsShutdown = false;
  supervisor.start();
  engine.answer({ type: 'ready' });
  engine.answer({ type: 'task', event: 'start', pid: 201 });
  const pending = supervisor.request('probe.wait');

  let stopped = false;
  const stopping = supervisor.shutdown().then(() => {
    stopped = true;
  });
  await tick();
  assert.equal(engine.sent('shutdown').length, 1);
  assert.equal(stopped, false);
  assert.equal(engine.killed, false);

  engine.answer({ type: 'task', event: 'end', pid: 201 });
  engine.answer({ type: 'shutdown-complete' });
  await stopping;
  assert.equal(engine.killed, true);
  assert.deepEqual(kills, []);
  assert.deepEqual(failures, []);
  await assert.rejects(pending);
  assert.equal(supervisor.phase(), 'stopped');
});

test('a shutdown the engine does not answer is cut short, and its tasks are forced', async () => {
  const { engine, kills, failures, supervisor } = supervise({ shutdownTimeoutMs: 50 });
  engine.confirmsShutdown = false;
  supervisor.start();
  engine.answer({ type: 'ready' });
  engine.answer({ type: 'task', event: 'start', pid: 301 });
  await supervisor.shutdown();
  assert.equal(engine.killed, true);
  assert.deepEqual(kills, [{ pid: 301, force: true }]);
  assert.deepEqual(failures, []);
});

test('the latest state of each domain is kept and passed on', async () => {
  const { engine, supervisor } = supervise();
  const seen = [];
  supervisor.onStatus((domain, value) => seen.push([domain, value]));
  supervisor.start();
  engine.answer({ type: 'status', domain: 'qgis', value: { state: 'checking' } });
  engine.answer({ type: 'status', domain: 'qgis', value: { state: 'ready' } });
  assert.deepEqual(supervisor.statuses(), { qgis: { state: 'ready' } });
  assert.equal(seen.length, 2);
  await supervisor.shutdown();
});
