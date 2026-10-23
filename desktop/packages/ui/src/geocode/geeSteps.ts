import type { GeeView } from './geoStatus';

/** How far a step of the setup is: done, not yet, or where the failure is. */
export type Mark = 'done' | 'todo' | 'problem';

/** What is known of the user's sign-in. */
export type Account = 'unknown' | 'signed-out' | 'expired' | 'signed-in';

export interface Steps {
  readonly account: Account;
  readonly project: Mark;
}

export const ACCOUNT_MARK = {
  unknown: 'todo',
  'signed-out': 'todo',
  expired: 'problem',
  'signed-in': 'done',
} satisfies Record<Account, Mark>;

const NOTHING: Steps = { account: 'unknown', project: 'todo' };

/**
 * The two steps of setting Earth Engine up, from a settled status: the check stops at the first that fails, so the
 * step after it is not known. A failure of the network belongs to neither.
 */
export const stepsOf = (view: GeeView | undefined): Steps => {
  if (!view) return NOTHING;
  switch (view.status) {
    case 'checking':
    case 'config-error':
    case 'unreadable':
    case 'check-failed':
    case 'check-timeout':
      return NOTHING;
    case 'signed-out':
      return { account: 'signed-out', project: 'todo' };
    case 'project-missing':
      return { account: 'signed-in', project: 'todo' };
    case 'rejected':
      return view.diagnostics.refusal === 'credentials-invalid'
        ? { account: 'expired', project: 'todo' }
        : { account: 'signed-in', project: 'problem' };
    // Found only after the credentials on this computer were.
    case 'unreachable':
    case 'ready':
      return { account: 'signed-in', project: 'done' };
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
