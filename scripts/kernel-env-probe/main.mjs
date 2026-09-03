// A windowless Electron app that starts the real GeoCode kernel the way main.mjs does, with a
// poisoned inherited environment, and reports what reached the child (docs/ENVIRONMENT.md §7).
// Run B bypasses the boundary on purpose: every probe has to fire there, or a quiet run A
// proves nothing. Exit code 0 only when A is clean and B is loud.
import { app, utilityProcess } from 'electron';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ELECTRON_PKG = path.resolve(HERE, '../../desktop/packages/electron');

const { startEmbeddedKernel } = await import(`${ELECTRON_PKG}/geocode/kernel-boot.mjs`);
const { startKernelHost } = await import(`${ELECTRON_PKG}/geocode/kernel-host.mjs`);
const { resolveKernelSidecarPath } = await import(`${ELECTRON_PKG}/geocode/kernel-paths.mjs`);

const say = (line) => console.error(`[probe ${new Date().toISOString().slice(11, 19)}] ${line}`);
const logger = { info: (m) => say(`kernel ${m}`), warn: (m) => say(`kernel ${m}`), error: (m) => say(`kernel ${m}`) };
const watchdog = setTimeout(() => { console.log('WATCHDOG: no verdict within 150s'); app.exit(2); }, 150_000);

const run = async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-kernel-probe-'));
  const dirs = {};
  for (const name of ['data', 'config', 'cache', 'state', 'project', 'poison']) {
    dirs[name] = path.join(scratch, name);
    fs.mkdirSync(dirs[name], { recursive: true });
  }
  fs.writeFileSync(path.join(dirs.poison, 'geocode.jsonc'), '{ "username": "poison-user" }\n');

  let otelConnections = 0;
  const otel = net.createServer((socket) => { otelConnections += 1; socket.destroy(); });
  await new Promise((resolve) => otel.listen(0, '127.0.0.1', resolve));
  const otelPort = otel.address().port;

  // XDG is redirected so the kernel never touches the developer's real roots; everything else
  // is what a poisoned login shell would hand main.mjs.
  const poisoned = (marker) => ({
    ...process.env,
    XDG_DATA_HOME: dirs.data,
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    OPENCODE_CONFIG_DIR: dirs.poison,
    OPENCODE_CONFIG: path.join(dirs.poison, 'geocode.jsonc'),
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otelPort}`,
    NODE_OPTIONS: `--require ${path.join(HERE, 'probe.cjs')}`,
    GEOCODE_PROBE_MARKER: marker,
    OPENCHAMBER_UI_PASSWORD: 'ui-secret-probe',
  });

  const authed = (connection, route) =>
    fetch(new URL(route, connection.baseUrl), {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${connection.password}`).toString('base64')}` },
      signal: AbortSignal.timeout(5000),
    }).then(async (r) => ({ status: r.status, body: await r.text() })).catch((e) => ({ status: 'error', body: String(e) }));

  const environBlock = (pid) => {
    try { return execSync(`ps -E -p ${pid} -o command=`, { encoding: 'utf8' }); } catch (e) { return `ps failed: ${e.message}`; }
  };

  const observe = async (label, handle, pid, marker) => {
    say(`${label}: ready at ${handle.connection.baseUrl}, pid ${pid}`);
    const healthy = await Promise.race([
      handle.health.wait.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 40_000)),
    ]);
    // The OTLP exporter batches on a five second schedule; give it time to try.
    await new Promise((r) => setTimeout(r, 9000));
    const environ = environBlock(pid);
    const config = await authed(handle.connection, '/config');
    const report = {
      run: label,
      healthy,
      configFromPoisonDir: config.status === 200 && config.body.includes('poison-user'),
      nodeOptionsExecuted: fs.existsSync(marker),
      otelConnections,
      inEnvironBlock: {
        NODE_OPTIONS: environ.includes('NODE_OPTIONS='),
        OPENCODE_CONFIG_DIR: environ.includes('OPENCODE_CONFIG_DIR='),
        OTEL_EXPORTER_OTLP_ENDPOINT: environ.includes('OTEL_EXPORTER_OTLP_ENDPOINT='),
        OPENCHAMBER_UI_PASSWORD: environ.includes('OPENCHAMBER_UI_PASSWORD='),
        XDG_CONFIG_HOME: environ.includes(`XDG_CONFIG_HOME=${dirs.config}`),
      },
      psWorked: !environ.startsWith('ps failed'),
    };
    await handle.stop();
    otelConnections = 0;
    return report;
  };

  let child;
  const fork = (modulePath, args, options) => { child = utilityProcess.fork(modulePath, args, options); return child; };
  const reports = [];
  let verdict = 1;
  try {
    const markerA = path.join(scratch, 'marker-A');
    const handleA = await startEmbeddedKernel({
      isDev: true,
      moduleDirectory: ELECTRON_PKG,
      resourcesPath: process.resourcesPath,
      fork,
      cwd: dirs.project,
      environment: poisoned(markerA),
      overrides: { OPENCHAMBER_UI_PASSWORD: undefined },
      logger,
    });
    const a = await observe('A product path', handleA, child.pid, markerA);
    reports.push(a);

    const markerB = path.join(scratch, 'marker-B');
    const handleB = await startKernelHost({
      fork,
      sidecarPath: resolveKernelSidecarPath({ isDev: true, moduleDirectory: ELECTRON_PKG }),
      cwd: dirs.project,
      environment: poisoned(markerB),
      logger,
    });
    const b = await observe('B control, boundary bypassed', handleB, child.pid, markerB);
    reports.push(b);

    const leaked = (r) => Object.entries(r.inEnvironBlock).filter(([k, v]) => k !== 'XDG_CONFIG_HOME' && v).map(([k]) => k);
    const aClean = a.healthy && !a.configFromPoisonDir && !a.nodeOptionsExecuted && a.otelConnections === 0
      && leaked(a).length === 0 && a.inEnvironBlock.XDG_CONFIG_HOME && a.psWorked;
    const bLoud = b.healthy && b.configFromPoisonDir && b.nodeOptionsExecuted && b.otelConnections > 0
      && leaked(b).length === 4;
    verdict = aClean && bLoud ? 0 : 1;
    reports.push({ verdict: verdict === 0 ? 'boundary held, and every probe fired in the control' : 'RED', aClean, bLoud });
  } catch (error) {
    reports.push({ error: String(error?.stack ?? error) });
  }

  otel.close();
  console.log(JSON.stringify(reports, null, 2));
  fs.rmSync(scratch, { recursive: true, force: true });
  clearTimeout(watchdog);
  app.exit(verdict);
};

// Electron fires ready only after the ESM entry finishes evaluating, so no top-level await here.
app.whenReady().then(run).catch((error) => { console.log(JSON.stringify([{ error: String(error?.stack ?? error) }])); app.exit(1); });
