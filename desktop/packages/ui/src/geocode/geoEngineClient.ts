import React from 'react';
import { z } from 'zod';

import { getDesktopBridge } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  geoStatusSnapshotSchema,
  NO_GEO_STATUSES,
  pythonGateOf,
  pythonOverlayOf,
  withGeoStatusEvent,
  withGeoStatusSnapshot,
  type GeoStatuses,
  type PythonGate,
  type PreparingGate,
} from './geoStatus';
import { PythonPreparing } from './PythonPreparing';

// The shell server's routes for GeoEngine, see web/server/geocode/geoengine.js.
const SNAPSHOT_PATH = '/api/geocode/geo-status';
const QGIS_PATH = '/api/geocode/qgis';

const refusalSchema = z.object({ error: z.string(), code: z.string().optional() });

const installsSchema = z.object({
  installs: z.array(z.object({ app: z.string(), version: z.string().optional() })),
});

const doneSchema = z.object({});

export type QgisInstall = z.infer<typeof installsSchema>['installs'][number];

/**
 * A refusal or a lost connection carries the reason to show, and GeoEngine's code for a refusal; it is never read as an
 * empty answer.
 */
type Outcome<T> ={ ok: true; value: T } | { ok: false; reason: string; code?: string };

const request = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<Outcome<T>> => {
  const response = await runtimeFetch(path, init).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in response) return { ok: false, reason: response.error };
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const refusal = refusalSchema.safeParse(body);
    return refusal.success
      ? { ok: false, reason: refusal.data.error, code: refusal.data.code }
      : { ok: false, reason: `GeoEngine request failed (${response.status})` };
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'GeoEngine answered in a form this interface cannot read' };
};

export const useGeoStatuses = (): GeoStatuses => useGeoEngineView().statuses;

/** The window waits on the loading screen until this opens it. */
export const usePythonGate = (): PythonGate => {
  const view = useGeoEngineView();
  return React.useMemo(() => pythonGateOf(view.statuses, view.engine), [view]);
};

/** The loading screen's `ready` and `note`, as pythonOverlayOf has them, once the rest of the start is done. */
export const usePythonOverlay = (gate: PythonGate, started: boolean) => {
  const last = React.useRef<PreparingGate | undefined>(undefined);
  const { ready, shown } = pythonOverlayOf(gate, started, last.current);
  // Written as it renders: rendering twice with the same gate keeps the same note.
  last.current = shown;
  return { ready, note: shown ? React.createElement(PythonPreparing, { gate: shown }) : undefined };
};

/** `engine`, whether the server has GeoEngine, is undefined until the first snapshot. */
const useGeoEngineView = (): { statuses: GeoStatuses; engine: boolean | undefined } => {
  const [statuses, setStatuses] = React.useState(NO_GEO_STATUSES);
  const [engine, setEngine] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    let active = true;
    const read = () => {
      void request(SNAPSHOT_PATH, geoStatusSnapshotSchema).then((outcome) => {
        if (!outcome.ok) {
          console.warn('[geocode] could not read the GeoEngine statuses:', outcome.reason);
          return;
        }
        if (!active) return;
        setStatuses((current) => withGeoStatusSnapshot(current, outcome.value));
        setEngine(outcome.value.engine);
      });
    };
    // Subscribed before the first read, so no change slips between them; changes sent while the stream was down are
    // lost, hence a read on every reconnect.
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'geo-status') setStatuses((current) => withGeoStatusEvent(current, event));
      if (event.type === 'event-stream-ready') read();
    });
    read();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return React.useMemo(() => ({ statuses, engine }), [statuses, engine]);
};

export const fetchQgisInstalls = async (): Promise<Outcome<QgisInstall[]>> => {
  const outcome = await request(`${QGIS_PATH}/installs`, installsSchema);
  return outcome.ok ? { ok: true, value: outcome.value.installs } : outcome;
};

/** GeoEngine writes the choice to machine.json and checks it; the outcome of the check arrives as a status. */
export const chooseQgis = (path: string) => request(QGIS_PATH, doneSchema, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path }),
});

export const recheckQgis = () => request(`${QGIS_PATH}/recheck`, doneSchema, { method: 'POST' });

const pickedSchema = z.string().min(1);

/**
 * The QGIS the user picks in the system's file dialog: its app on macOS, its folder on Windows, where GeoEngine finds
 * the QGIS anywhere inside one; null when they cancel or there is no dialog.
 */
export const pickQgisApp = async (titles: { app: string; folder: string }): Promise<string | null> => {
  const windows = window.__OPENCHAMBER_PLATFORM__ === 'win32';
  const picked = pickedSchema.safeParse(await getDesktopBridge()?.openDialog?.(windows
    ? { title: titles.folder, directory: true, multiple: false, defaultPath: 'C:\\Program Files' }
    : {
      title: titles.app,
      directory: false,
      multiple: false,
      defaultPath: '/Applications',
      filters: [{ name: 'QGIS', extensions: ['app'] }],
    }));
  return picked.success ? picked.data : null;
};

const GEE_PATH = '/api/geocode/gee';

/** GeoEngine writes the project and checks again; the outcome arrives as a status. */
export const configureGee = (project: string) => request(GEE_PATH, doneSchema, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ project }),
});

export const recheckGee = () => request(`${GEE_PATH}/recheck`, doneSchema, { method: 'POST' });

/** As GeoEngine's Quota.Snapshot (geoengine/src/gee/quota.ts): EECU-seconds, and times in ISO 8601. */
const quotaSchema = z.object({
  project: z.string(),
  limitSeconds: z.number().nullable(),
  usedSeconds: z.number().nullable(),
  sampledAt: z.string().nullable(),
  resetsAt: z.string(),
});

export type GeeQuota = z.infer<typeof quotaSchema>;

/** The configured project's monthly quota, asked of Google now; GEE's state is the same whatever the outcome. */
export const fetchGeeQuota = () => request(`${GEE_PATH}/quota`, quotaSchema);

const signInLineSchema = z.union([
  z.object({ type: z.literal('progress'), data: z.object({ url: z.string() }) }),
  z.object({ type: z.literal('result'), ok: z.literal(true) }),
  z.object({ type: z.literal('result'), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

type SignInLine = z.infer<typeof signInLineSchema>;

/** A line of the sign-in's answer; null for one this interface cannot read. */
const signInLine = (text: string): SignInLine | null => {
  try {
    const line = signInLineSchema.safeParse(JSON.parse(text));
    return line.success ? line.data : null;
  } catch {
    return null;
  }
};

/** How a sign-in ended: GeoEngine's code says why it failed, as "denied" or "timeout"; "aborted" is this page's own. */
export type SignInEnd = { ok: true } | { ok: false; code: string; reason: string };

/**
 * Signs in with the configured Python, handing on the address the browser is to open as soon as GeoEngine has it.
 * Aborting the signal ends the sign-in in GeoEngine too.
 */
export const signInGee = async (onUrl: (url: string) => void, signal: AbortSignal): Promise<SignInEnd> => {
  const response = await runtimeFetch(`${GEE_PATH}/sign-in`, { method: 'POST', signal })
    .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in response) return { ok: false, code: signal.aborted ? 'aborted' : 'unavailable', reason: response.error };
  if (!response.ok || !response.body) return { ok: false, code: 'unavailable', reason: `GeoEngine request failed (${response.status})` };
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const ended = (line: Extract<SignInLine, { type: 'result' }>): SignInEnd => {
    void reader.cancel().catch(() => {});
    return line.ok ? { ok: true } : { ok: false, code: line.error.code, reason: line.error.message };
  };
  let pending = '';
  for (;;) {
    const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
    // The last line may come without its newline.
    const lines = chunk.done ? [pending] : (pending + chunk.value).split('\n');
    pending = chunk.done ? '' : lines.pop() ?? '';
    for (const text of lines) {
      const line = signInLine(text);
      if (!line) continue;
      if (line.type === 'progress') onUrl(line.data.url);
      else return ended(line);
    }
    if (chunk.done) break;
  }
  return { ok: false, code: signal.aborted ? 'aborted' : 'unavailable', reason: 'the connection to GeoEngine ended' };
};
