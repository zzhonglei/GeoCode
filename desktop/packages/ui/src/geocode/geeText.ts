import type { GeeStatus, GeeView } from './geoStatus';

type Refusal = NonNullable<Extract<GeeStatus, { diagnostics: unknown }>['diagnostics']['refusal']>;

/** As QGIS_STATUS: in English whatever the interface language, and short. A refusal is named by its reason. */
const GEE_STATUS = {
  unconfigured: 'Not set up',
  checking: 'Checking…',
  ready: 'Ready',
  'config-error': 'Settings unreadable',
  'python-missing': 'Python not found',
  'packages-missing': 'Packages missing',
  'packages-broken': 'Packages broken',
  'signed-out': 'Not signed in',
  'project-missing': 'No project',
  unreachable: 'Unreachable',
  'check-timeout': 'Check timed out',
  'check-failed': 'Check failed',
  unreadable: 'Unknown status',
} satisfies Record<Exclude<GeeView['status'], 'rejected'>, string>;

const REFUSED = {
  'credentials-invalid': 'Sign-in expired',
  'project-not-found': 'Project not found',
  'no-permission': 'No access to project',
  'api-disabled': 'API not enabled',
  other: 'Refused',
} satisfies Record<Refusal, string>;

export const geeLabel = (view: GeeView): string =>
  view.status === 'rejected' ? REFUSED[view.diagnostics.refusal ?? 'other'] : GEE_STATUS[view.status];

/** What a ready Earth Engine runs with, on one line. */
export const geeSummaryOf = (status: Extract<GeeStatus, { status: 'ready' }>) =>
  [
    status.project,
    status.versions['earthengine-api'] ? `earthengine-api ${status.versions['earthengine-api']}` : null,
    status.versions.python ? `Python ${status.versions.python}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** The failure itself, on a line: what Google said when it answered, GeoEngine's message otherwise. */
export const geeMessageOf = (status: Extract<GeeStatus, { diagnostics: unknown }>) =>
  status.diagnostics.said ?? status.diagnostics.message;

/** Everything known about a failure, as shown under Diagnostics and copied; in English, as the state's name is. */
export const geeDiagnosticsOf = (view: GeeView): string => {
  if (view.status === 'unreadable') return JSON.stringify(view.value, null, 2);
  const heading = `Google Earth Engine: ${geeLabel(view)} (${view.status === 'rejected' ? `rejected, ${view.diagnostics.refusal ?? 'other'}` : view.status})`;
  if (!('diagnostics' in view)) return heading;
  const diagnostics = view.diagnostics;
  return [
    heading,
    diagnostics.message,
    diagnostics.said && diagnostics.said !== diagnostics.message ? `Google said: ${diagnostics.said}` : null,
    diagnostics.file ? `File: ${diagnostics.file}` : null,
    diagnostics.python ? `Python: ${diagnostics.python}` : null,
    diagnostics.project ? `Project: ${diagnostics.project}` : null,
    diagnostics.missing?.length ? `Not installed: ${diagnostics.missing.join(', ')}` : null,
    diagnostics.broken?.length
      ? `Failing to import:\n${diagnostics.broken.map((item) => `${item.package}: ${item.error}`).join('\n')}`
      : null,
    diagnostics.output?.trim() ? `Output:\n${diagnostics.output.trim()}` : null,
    diagnostics.traceback?.trim() ? `Traceback:\n${diagnostics.traceback.trim()}` : null,
  ]
    .filter(Boolean)
    .join('\n');
};
