import { create } from 'zustand';

import { openExternalUrl } from '@/lib/url';
import { signInGee } from './geoEngineClient';

export type SignIn =
  | { phase: 'idle' }
  /** The address is null until GeoEngine has it. */
  | { phase: 'waiting'; url: string | null }
  | { phase: 'failed'; code: string; reason: string };

type SignInState = {
  signIn: SignIn;
  start: () => void;
  cancel: () => void;
  /** Forgets a failure, once a later check has said where the sign-in stands. */
  dismiss: () => void;
};

/** Ended without a failure to show: by the user, by a sign-in started elsewhere, or by leaving it. */
const QUIET = new Set(['aborted', 'cancelled', 'replaced']);

let controller: AbortController | null = null;

// Outside the page, so closing the settings leaves a sign-in waiting in the browser to finish.
export const useGeeSignIn = create<SignInState>()((set) => ({
  signIn: { phase: 'idle' },
  start: () => {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    set({ signIn: { phase: 'waiting', url: null } });
    void signInGee((url) => {
      if (controller !== mine) return;
      set({ signIn: { phase: 'waiting', url } });
      void openExternalUrl(url);
    }, mine.signal).then((end) => {
      if (controller !== mine) return;
      controller = null;
      // A sign-in that worked shows as the status GeoEngine's check after it reports.
      if (end.ok || QUIET.has(end.code)) set({ signIn: { phase: 'idle' } });
      else set({ signIn: { phase: 'failed', code: end.code, reason: end.reason } });
    });
  },
  cancel: () => {
    controller?.abort();
    controller = null;
    set({ signIn: { phase: 'idle' } });
  },
  dismiss: () => set((state) => (state.signIn.phase === 'failed' ? { signIn: { phase: 'idle' } } : state)),
}));
