import { z } from 'zod';

/** What the shell server sends on the control stream for every change; geoStatus.test.ts holds it to the server's. */
export const GEO_STATUS_EVENT = 'geocode:geo-status';

export const geoStatusEventSchema = z.object({ revision: z.number(), domain: z.string(), value: z.unknown() });

export type GeoStatusEvent = { type: 'geo-status' } & z.infer<typeof geoStatusEventSchema>;

export const geoStatusSnapshotSchema = z.object({
  revision: z.number(),
  statuses: z.record(z.string(), z.unknown()),
  engine: z.boolean(),
});

type GeoStatusSnapshot = z.infer<typeof geoStatusSnapshotSchema>;

/** Each domain keeps the revision its value came with, so a snapshot older than a change leaves that domain alone. */
export interface GeoStatuses {
  readonly [domain: string]: { readonly revision: number; readonly value: unknown };
}

export const NO_GEO_STATUSES: GeoStatuses = {};

export const withGeoStatusEvent = (current: GeoStatuses, event: GeoStatusEvent): GeoStatuses => {
  const held = current[event.domain];
  if (held && held.revision >= event.revision) return current;
  return { ...current, [event.domain]: { revision: event.revision, value: event.value } };
};

export const withGeoStatusSnapshot = (current: GeoStatuses, snapshot: GeoStatusSnapshot): GeoStatuses => {
  const next = { ...current };
  for (const [domain, value] of Object.entries(snapshot.statuses)) {
    const held = next[domain];
    if (held && held.revision > snapshot.revision) continue;
    next[domain] = { revision: snapshot.revision, value };
  }
  return next;
};

// State in geoengine/src/python/index.ts; of preparing, only the warm-up's package is read here.
const pythonSchema = z.union([
  z.object({ status: z.literal('checking') }),
  z.object({ status: z.literal('preparing'), step: z.literal('warming'), name: z.string(), number: z.number(), total: z.number() }),
  z.object({ status: z.literal('preparing') }),
  z.object({ status: z.literal('ready') }),
  z.object({
    status: z.literal('failed'),
    diagnostics: z.object({ step: z.string(), message: z.string(), output: z.string().optional() }),
  }),
]);

/** The package the warm-up is importing, `number` counting from 1. */
type PythonLoading = { name: string; number: number; total: number };

/**
 * Whether a window may open: it waits for GeoCode's Python environment, unless this server has no GeoEngine. While the
 * environment is installed, created, or warmed up after either, the loading screen says so.
 */
export type PythonGate =
  | { state: 'waiting' }
  | { state: 'preparing'; loading?: PythonLoading }
  | { state: 'open' }
  | { state: 'failed'; error: string };

/** `engine` is undefined until the server has said whether it has GeoEngine. */
export const pythonGateOf = (statuses: GeoStatuses, engine: boolean | undefined): PythonGate => {
  if (engine === false) return { state: 'open' };
  const held = statuses.python;
  if (!held) return { state: 'waiting' };
  const parsed = pythonSchema.safeParse(held.value);
  // A value this interface cannot read would otherwise hold the window shut for good.
  if (!parsed.success) return { state: 'failed', error: JSON.stringify(held.value, null, 2) };
  if (parsed.data.status === 'ready') return { state: 'open' };
  if (parsed.data.status === 'checking') return { state: 'waiting' };
  if (parsed.data.status === 'preparing') {
    if (!('step' in parsed.data)) return { state: 'preparing' };
    const { name, number, total } = parsed.data;
    return { state: 'preparing', loading: { name, number, total } };
  }
  const failed = parsed.data.diagnostics;
  return { state: 'failed', error: [`${failed.step}: ${failed.message}`, failed.output].filter(Boolean).join('\n\n') };
};

export type PreparingGate = Extract<PythonGate, { state: 'preparing' }>;

/**
 * Whether the loading screen may go, once the rest of the start is done, and what it says. `shown` is what it said
 * last: kept once it may go, so the note fades out with the logo instead of giving way to upstream's slow-start line.
 */
export const pythonOverlayOf = (gate: PythonGate, started: boolean, shown: PreparingGate | undefined) => {
  const ready = started && gate.state === 'open';
  return { ready, shown: ready ? shown : gate.state === 'preparing' ? gate : undefined };
};

// The failures of State in geoengine/src/qgis/index.ts; geoStatus.test.ts holds the two lists together.
export const QGIS_FAILURES = [
  'config-error',
  'platform-unsupported',
  'path-missing',
  'not-qgis',
  'ambiguous',
  'python-missing',
  'gdal-missing',
  'proj-broken',
  'core-missing',
  'processing-failed',
  'probe-timeout',
  'probe-failed',
] as const;

const diagnosticsSchema = z.object({
  message: z.string(),
  file: z.string().optional(),
  path: z.string().optional(),
  app: z.string().optional(),
  version: z.string().optional(),
  interpreter: z.string().optional(),
  output: z.string().optional(),
  folder: z.string().optional(),
  choices: z.array(z.object({ app: z.string(), version: z.string().optional() })).optional(),
  environment: z.record(z.string(), z.string()).optional(),
});

const qgisSchema = z.union([
  z.object({ status: z.literal('unconfigured') }),
  z.object({ status: z.literal('checking'), path: z.string() }),
  z.object({
    status: z.literal('ready'),
    app: z.string(),
    interpreter: z.string(),
    version: z.string().optional(),
    versions: z.object({ qgis: z.string(), gdal: z.string(), python: z.string() }),
    algorithms: z.number(),
  }),
  z.object({ status: z.enum(QGIS_FAILURES), diagnostics: diagnosticsSchema }),
]);

export type QgisStatus = z.infer<typeof qgisSchema>;

export type QgisView = QgisStatus | { status: 'unreadable'; value: unknown };

/** Undefined before GeoEngine reports QGIS; a value this interface cannot read is kept whole, to be shown and copied. */
export const qgisStatusOf = (statuses: GeoStatuses): QgisView | undefined => {
  const held = statuses.qgis;
  if (!held) return undefined;
  const parsed = qgisSchema.safeParse(held.value);
  return parsed.success ? parsed.data : { status: 'unreadable', value: held.value };
};

// The failures of State in geoengine/src/gee/index.ts, and why Earth Engine refused; geoStatus.test.ts holds them together.
export const GEE_FAILURES = [
  'config-error',
  'signed-out',
  'project-missing',
  'unreachable',
  'rejected',
  'check-timeout',
  'check-failed',
] as const;

export const GEE_REFUSALS = ['credentials-invalid', 'project-not-found', 'no-permission', 'api-disabled', 'other'] as const;

const geeDiagnosticsSchema = z.object({
  message: z.string(),
  file: z.string().optional(),
  project: z.string().optional(),
  refusal: z.enum(GEE_REFUSALS).optional(),
  said: z.string().optional(),
  output: z.string().optional(),
  traceback: z.string().optional(),
});

const geeSchema = z.union([
  z.object({ status: z.literal('checking'), project: z.string().optional() }),
  z.object({ status: z.literal('ready'), project: z.string() }),
  z.object({ status: z.enum(GEE_FAILURES), diagnostics: geeDiagnosticsSchema }),
]);

export type GeeStatus = z.infer<typeof geeSchema>;

export type GeeView = GeeStatus | { status: 'unreadable'; value: unknown };

/** As qgisStatusOf, for Google Earth Engine. */
export const geeStatusOf = (statuses: GeoStatuses): GeeView | undefined => {
  const held = statuses.gee;
  if (!held) return undefined;
  const parsed = geeSchema.safeParse(held.value);
  return parsed.success ? parsed.data : { status: 'unreadable', value: held.value };
};

export type Light = 'ready' | 'checking' | 'idle' | 'failed';

export const DOT_CLASS = {
  ready: 'bg-[var(--status-success)]',
  // Blinks while checking, through useWaitingBlink where it is shown.
  checking: 'bg-[var(--status-warning)]',
  idle: 'bg-muted-foreground/40',
  failed: 'bg-[var(--status-error)]',
} satisfies Record<Light, string>;

/**
 * Setup not yet finished rather than broken, as Earth Engine before the user signs in or names a project. By name, for
 * every domain: a domain's own state named so is grey too.
 */
const UNFINISHED: ReadonlySet<string> = new Set(['unconfigured', 'signed-out', 'project-missing']);

// Not configured is no fault: a new user should not meet a red light, nor one still setting up.
export const lightOf = (status: string): Light => {
  if (status === 'ready') return 'ready';
  if (status === 'checking') return 'checking';
  if (UNFINISHED.has(status)) return 'idle';
  return 'failed';
};
