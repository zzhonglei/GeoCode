import type { GeeView } from './geoStatus';

/** How far a step of the setup is: done, not yet, or where the failure is. */
export type Mark = 'done' | 'todo' | 'problem';

/** What is known of the user's sign-in; the check looks at it only once the Python works. */
export type Account = 'no-python' | 'unknown' | 'signed-out' | 'expired' | 'signed-in';

export interface Steps {
  readonly python: Mark;
  readonly account: Account;
  readonly project: Mark;
}

export const ACCOUNT_MARK = {
  'no-python': 'todo',
  unknown: 'todo',
  'signed-out': 'todo',
  expired: 'problem',
  'signed-in': 'done',
} satisfies Record<Account, Mark>;

const NOTHING: Steps = { python: 'todo', account: 'no-python', project: 'todo' };

/**
 * The three steps of setting Earth Engine up, from a settled status: the check stops at the first that fails, so the
 * steps after it are not known. A failure of the network belongs to none of them.
 */
export const stepsOf = (view: GeeView | undefined): Steps => {
  if (!view) return NOTHING;
  switch (view.status) {
    case 'unconfigured':
    case 'checking':
    case 'config-error':
    case 'unreadable':
      return NOTHING;
    case 'python-missing':
    case 'packages-missing':
    case 'packages-broken':
      return { python: 'problem', account: 'unknown', project: 'todo' };
    // Ended or cut off anywhere, the importing of the packages included.
    case 'check-failed':
    case 'check-timeout':
      return { python: 'todo', account: 'unknown', project: 'todo' };
    case 'signed-out':
      return { python: 'done', account: 'signed-out', project: 'todo' };
    case 'project-missing':
      return { python: 'done', account: 'signed-in', project: 'todo' };
    case 'rejected':
      return view.diagnostics.refusal === 'credentials-invalid'
        ? { python: 'done', account: 'expired', project: 'todo' }
        : { python: 'done', account: 'signed-in', project: 'problem' };
    // Found only after the packages and the credentials on this computer were.
    case 'unreachable':
    case 'ready':
      return { python: 'done', account: 'signed-in', project: 'done' };
  }
};

/** The Python and project the configuration names, as far as the status tells. */
export interface Configured {
  readonly python?: string;
  readonly project?: string;
}

export const sameConfigured = (one: Configured, other: Configured) =>
  one.python === other.python && one.project === other.project;

export const configuredOf = (view: GeeView | undefined): Configured => {
  if (!view || view.status === 'unreadable' || view.status === 'config-error') return {};
  if (view.status === 'unconfigured') return { project: view.project };
  if (view.status === 'checking' || view.status === 'ready') return { python: view.python, project: view.project };
  return { python: view.diagnostics.python, project: view.diagnostics.project };
};

/**
 * Whether a project ID can be saved: GeoEngine's own test, in ASCII as the request to Earth Engine carries it, with a
 * domain and a colon before it for some older projects.
 */
export const isProjectId = (text: string) => /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/.test(text);
