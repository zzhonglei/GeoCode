import type { StepMark } from './GeoDetailsParts';
import type { GeeView } from './geoStatus';

/** What is known of the user's sign-in. */
export type Account = 'unknown' | 'signed-out' | 'expired' | 'signed-in';

/**
 * The sign-in a settled status tells of: the check stops at the first step that fails, so one that failed before the
 * sign-in was looked at says nothing of it. A failure of the network comes after it.
 */
export const accountOf = (view: GeeView | undefined): Account => {
  if (!view) return 'unknown';
  switch (view.status) {
    case 'checking':
    case 'config-error':
    case 'unreadable':
    case 'check-failed':
    case 'check-timeout':
      return 'unknown';
    case 'signed-out':
      return 'signed-out';
    case 'rejected':
      return view.diagnostics.refusal === 'credentials-invalid' ? 'expired' : 'signed-in';
    case 'project-missing':
    case 'unreachable':
    case 'ready':
      return 'signed-in';
  }
};

/** Why Earth Engine cannot be used, as the settings page explains it; undefined when nothing is at fault. */
export type GeeFault =
  | 'config-error'
  | 'credentials-invalid'
  | 'project-not-found'
  | 'no-permission'
  | 'api-disabled'
  | 'refused'
  | 'unreachable'
  | 'failing'
  | 'check-timeout'
  | 'check-failed'
  | 'unreadable';

export const faultOf = (view: GeeView | undefined): GeeFault | undefined => {
  if (!view) return undefined;
  switch (view.status) {
    case 'checking':
    case 'ready':
    case 'signed-out':
    case 'project-missing':
      return undefined;
    case 'rejected': {
      const refusal = view.diagnostics.refusal ?? 'other';
      return refusal === 'other' ? 'refused' : refusal;
    }
    // GeoEngine gives the HTTP status only of Earth Engine answering that it is failing or busy.
    case 'unreachable':
      return view.diagnostics.status === undefined ? 'unreachable' : 'failing';
    case 'config-error':
    case 'check-timeout':
    case 'check-failed':
    case 'unreadable':
      return view.status;
  }
};

/** The check's four steps in GeoEngine's order: the sign-in on this computer, the project, Google, Earth Engine. */
type GeeMarks = readonly [StepMark, StepMark, StepMark, StepMark];

/**
 * How each step stands. Signing in and naming a project are the user's next steps, not faults. While a check runs every
 * step it checks waits alike, as it reports only when it ends; `signedIn` keeps the sign-in passed while only a new
 * project is checked. Google not reached is put on the step that refreshes the sign-in, the check's first request,
 * though the check reports it the same when it happens on the last; Earth Engine failing or busy is its last step.
 */
export const marksOf = (view: GeeView | undefined, signedIn: boolean): GeeMarks => {
  if (!view) return ['waiting', 'waiting', 'waiting', 'waiting'];
  switch (view.status) {
    case 'ready':
      return ['done', 'done', 'done', 'done'];
    case 'checking':
      return [signedIn ? 'done' : 'busy', 'busy', 'busy', 'busy'];
    case 'signed-out':
      return ['todo', 'waiting', 'waiting', 'waiting'];
    case 'project-missing':
      return ['done', 'todo', 'waiting', 'waiting'];
    case 'rejected':
      return view.diagnostics.refusal === 'credentials-invalid'
        ? ['done', 'done', 'failed', 'skipped']
        : ['done', 'done', 'done', 'failed'];
    case 'unreachable':
      return view.diagnostics.status === undefined ? ['done', 'done', 'failed', 'skipped'] : ['done', 'done', 'done', 'failed'];
    case 'config-error':
    case 'check-timeout':
    case 'check-failed':
    case 'unreadable':
      return ['skipped', 'skipped', 'skipped', 'skipped'];
  }
};

/** The project the configuration names, as far as the status tells. */
export const projectOf = (view: GeeView | undefined): string | undefined => {
  if (!view || view.status === 'unreadable' || view.status === 'config-error') return undefined;
  if (view.status === 'checking' || view.status === 'ready') return view.project;
  return view.diagnostics.project;
};

/**
 * Whether a project ID can be saved: GeoEngine's own test, in ASCII as the request to Earth Engine carries it, with a
 * domain and a colon before it for some older projects.
 */
export const isProjectId = (text: string) => /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/.test(text);
