import { create } from 'zustand';

import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatDateTimeForPreference, formatTimeForPreference } from '@/lib/timeFormat';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { fetchGeeQuota, type GeeQuota } from './geoEngineClient';
import type { GeeText } from './geeText';

/** How long a quota found stays shown, as the views open, without asking Google again. */
const FRESH_MS = 5 * 60 * 1000;

/** What is known of one project's quota; the last one found stays while it is asked again, and if that fails. */
type QuotaEntry = {
  project: string;
  quota?: GeeQuota;
  /** Why the last query failed, with GeoEngine's code for it when GeoEngine answered. */
  failure?: { reason: string; code?: string };
  loading: boolean;
  /** When the last query ended, in ms. */
  at: number;
};

type QuotaState = {
  entry: QuotaEntry | null;
  /** Asks unless a quota of the project was found recently: the status card and the settings page, as they open. */
  ensure: (project: string) => void;
  /** Asks again now, as the settings page's refresh button does. */
  refresh: (project: string) => void;
};

// Numbers each query: only the latest one's answer counts, and an answer to one asked before it is dropped.
let asked = 0;

// Outside both views, so the status card and the settings page show the same quota and ask once between them.
export const useGeeQuota = create<QuotaState>()((set, get) => {
  const load = (project: string) => {
    const mine = ++asked;
    const before = get().entry;
    const kept = before?.project === project ? before.quota : undefined;
    set({ entry: { project, quota: kept, loading: true, at: before?.project === project ? before.at : 0 } });
    void fetchGeeQuota().then((outcome) => {
      if (mine !== asked) return;
      set({
        // Under the project GeoEngine asked about, which may be one configured since the view asked.
        entry: outcome.ok
          ? { project: outcome.value.project, quota: outcome.value, loading: false, at: Date.now() }
          : { project, quota: kept, failure: { reason: outcome.reason, code: outcome.code }, loading: false, at: Date.now() },
      });
    });
  };
  return {
    entry: null,
    ensure: (project) => {
      const entry = get().entry;
      // A failure is asked again at once: what failed, as a service not yet enabled, may be put right in a minute.
      const fresh = entry?.quota !== undefined && entry.failure === undefined && Date.now() - entry.at < FRESH_MS;
      if (entry?.project === project && (entry.loading || fresh)) return;
      load(project);
    },
    refresh: (project) => {
      const entry = get().entry;
      if (entry?.project === project && entry.loading) return;
      load(project);
    },
  };
});

type Tone = 'plain' | 'muted' | 'error';

/**
 * The quota as both views show it, in rows that are there in every state, so a state changing changes no layout:
 * the share used beside the bar, the bar, and the settings page's two lines or the status card's one.
 */
export type QuotaRows = {
  /** The share used, or that the project has no limit. */
  value: string;
  valueTone: Tone;
  bar: { kind: 'share'; percent: number } | { kind: 'empty' } | { kind: 'unlimited' };
  busy: boolean;
  /** `detail`, the whole of what went wrong, where the line says only that Google cannot be reached. */
  first: { text: string; tone: Tone; detail?: string };
  /** Empty where there is nothing more to say; the line keeps its height. */
  second: { text: string; tone: Tone };
  /** The status card's line, which sends a failure's reason to the settings page. */
  card: { text: string; tone: Tone };
};

/** Hours of EECU time, to a tenth. */
const hours = (seconds: number) =>
  new Intl.NumberFormat(getCurrentIntlLocale(), { maximumFractionDigits: 1 }).format(seconds / 3600);

const share = (percent: number) =>
  new Intl.NumberFormat(getCurrentIntlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(percent / 100);

/** A time of day when it is today, a date and time otherwise, in the user's time zone and clock. */
const when = (iso: string, preference: TimeFormatPreference, now: Date) => {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) return formatTimeForPreference(date, preference);
  return formatDateTimeForPreference(date, preference, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const BLANK = { text: '', tone: 'muted' } as const;

/** The rows of a quota found: its share used, the hours used, and when it resets and was sampled. */
const found = (
  quota: GeeQuota,
  text: GeeText['quota'],
  preference: TimeFormatPreference,
  now: Date,
): Omit<QuotaRows, 'busy'> => {
  const resets = text.resets(when(quota.resetsAt, preference, now));
  const used = quota.usedSeconds;
  const sampled = quota.sampledAt;
  const limit = quota.limitSeconds;
  const second = {
    text: used === null || sampled === null ? resets : text.together(resets, text.sampled(when(sampled, preference, now))),
    tone: 'muted' as const,
  };
  if (used === null) {
    // The card's one line says so too, as a dash beside the bar could be read as a quota not found.
    const none = {
      first: { text: text.noData, tone: 'muted' as const },
      second,
      card: { text: text.together(text.noData, resets), tone: 'muted' as const },
    };
    return limit === null
      ? { ...none, value: text.unlimited, valueTone: 'plain', bar: { kind: 'unlimited' } }
      : { ...none, value: '—', valueTone: 'muted', bar: { kind: 'empty' } };
  }
  if (limit === null) {
    const first = { text: text.usedNoLimit(hours(used)), tone: 'plain' as const };
    return { first, second, card: second, value: text.unlimited, valueTone: 'plain', bar: { kind: 'unlimited' } };
  }
  // A project allowed none has used it all once it uses any.
  const percent = limit > 0 ? (used / limit) * 100 : used > 0 ? 100 : 0;
  const first = { text: text.used(hours(used), hours(limit)), tone: 'plain' as const };
  return { first, second, card: second, value: share(percent), valueTone: 'plain', bar: { kind: 'share', percent } };
};

export const quotaRows = (
  entry: QuotaEntry | null,
  text: GeeText['quota'],
  preference: TimeFormatPreference,
  now = new Date(),
): QuotaRows => {
  const busy = entry?.loading ?? true;
  const quota = entry?.quota;
  const loading = { text: text.loading, tone: 'muted' as const };
  const rows = quota
    ? found(quota, text, preference, now)
    : { value: '—', valueTone: 'muted' as const, bar: { kind: 'empty' as const }, first: loading, second: BLANK, card: loading };
  const failure = entry?.failure;
  if (failure === undefined) return { ...rows, busy };
  // A failure takes the lines; a quota found before it keeps its numbers, and the line saying when it was sampled.
  const since = quota ? rows.second : BLANK;
  if (failure.code === 'unreachable') {
    // Only the fact, as GEE's own check says it: what the network needs is for the user to work out.
    return {
      ...rows,
      busy,
      first: { text: text.unreachable, tone: 'error', detail: failure.reason },
      second: since,
      card: { text: text.cardUnreachable, tone: 'error' },
    };
  }
  return {
    ...rows,
    busy,
    first: { text: text.failedBecause(failure.reason), tone: 'error' },
    // What the query needs of the project is said only where the query itself failed, not GeoEngine or the network.
    second: failure.code === 'quota-failed' ? { text: text.needs, tone: 'muted' } : since,
    card: { text: text.failedSee, tone: 'error' },
  };
};
