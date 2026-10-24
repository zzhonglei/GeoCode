import { beforeEach, expect, mock, test } from 'bun:test';
import fs from 'node:fs';

import type { GeeQuota } from './geoEngineClient';

// Stands in for the request to GeoEngine: each call is counted and answers as the test sets it.
let calls = 0;
let answer: { ok: true; value: GeeQuota } | { ok: false; reason: string; code?: string } = { ok: false, reason: 'unset' };
mock.module('./geoEngineClient', () => ({
  fetchGeeQuota: async () => {
    calls += 1;
    return answer;
  },
}));

const { quotaRows, useGeeQuota } = await import('./geeQuotaStore');
const { geeText } = await import('./geeText');

const TEXT = geeText('zh-CN').quota;
const HOUR = 3600;
const QUOTA: GeeQuota = {
  project: 'majestic',
  limitSeconds: 150 * HOUR,
  usedSeconds: 25.2 * HOUR,
  sampledAt: '2026-10-24T07:28:00Z',
  resetsAt: '2026-11-01T07:00:00Z',
};
const NOW = new Date('2026-10-24T08:00:00Z');
const entry = (
  fields: Partial<{ quota: GeeQuota; loading: boolean }>,
) => ({
  project: 'majestic',
  loading: false,
  at: 0,
  ...fields,
});
const rows = (shown: ReturnType<typeof entry> | null) => quotaRows(shown, TEXT, '24h', NOW);
/** Until the stand-in's answer has reached the store. */
const answered = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  calls = 0;
  useGeeQuota.setState({ entry: null });
});

/** The names of a schema's fields, as written in `source` after `start`. */
const fieldsIn = (path: string, start: string) => {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const block = source.slice(source.indexOf(start)).split(/\n\}\)/)[0];
  return [...block.matchAll(/^\s+(\w+): /gm)].map((match) => match[1]).sort();
};

// Guards against the interface reading the quota under other names than GeoEngine sends it by.
test('GeoCode: the interface reads every field of the quota GeoEngine sends', () => {
  const engine = fieldsIn('../../../../../geoengine/src/gee/quota.ts', 'const Snapshot = Schema.Struct({');
  expect(engine.length).toBeGreaterThan(0);
  expect(fieldsIn('./geoEngineClient.ts', 'const quotaSchema = z.object({')).toEqual(engine);
});

// Guards against EECU-seconds shown as hours wrongly, the share taken of the wrong number, or a sample shown as none.
test('GeoCode: a quota shows its share used, hours used of the limit, and when it resets and was sampled', () => {
  const shown = rows(entry({ quota: QUOTA }));
  expect(shown.value).toBe('17%');
  expect(shown.bar).toEqual({ kind: 'share', percent: 16.8 });
  expect(shown.first.text).toBe(TEXT.used('25.2', '150'));
  expect(shown.second.text).toContain(TEXT.sampled(''));
  expect(shown.card).toEqual(shown.second);
  expect(shown.busy).toBe(false);
  expect(rows(entry({ quota: { ...QUOTA, usedSeconds: 180 * HOUR } })).value).toBe('120%');
});

// Guards against a month with no sample yet reading as nothing used, and no limit as an empty bar.
test('GeoCode: unknown usage is not zero, and no limit is not an empty bar', () => {
  const none = rows(entry({ quota: { ...QUOTA, usedSeconds: null, sampledAt: null } }));
  expect(none.value).toBe('—');
  expect(none.bar).toEqual({ kind: 'empty' });
  expect(none.first.text).toBe(TEXT.noData);
  expect(none.card.text.startsWith(TEXT.noData)).toBe(true);
  expect(none.second.text).not.toContain(TEXT.sampled(''));
  const free = rows(entry({ quota: { ...QUOTA, limitSeconds: null } }));
  expect(free.bar).toEqual({ kind: 'unlimited' });
  expect(free.value).toBe(TEXT.unlimited);
  expect(free.first.text).toBe(TEXT.usedNoLimit('25.2'));
  const over = rows(entry({ quota: { ...QUOTA, limitSeconds: 0 } }));
  expect(over.bar).toEqual({ kind: 'share', percent: 100 });
});

// Guards against a failed refresh throwing away the quota found, a network failure shown in Python's words, which say
// nothing to the user, or the words lost; and against the quota kept beside a failure counting as fresh.
test('GeoCode: a refresh that cannot reach Google keeps the quota found and is asked again as a view opens', async () => {
  answer = { ok: true, value: QUOTA };
  useGeeQuota.getState().refresh('majestic');
  await answered();
  answer = { ok: false, reason: 'ReadTimeout: Read timed out. (read timeout=10)', code: 'unreachable' };
  useGeeQuota.getState().refresh('majestic');
  await answered();
  const shown = rows(useGeeQuota.getState().entry);
  expect(shown.value).toBe('17%');
  expect(shown.first).toEqual({ text: TEXT.unreachable, tone: 'error', detail: answer.reason });
  expect(shown.second.text).toContain(TEXT.sampled(''));
  useGeeQuota.getState().ensure('majestic');
  expect(calls).toBe(3);
});

// Guards against the numbers vanishing while a refresh runs, and the page jumping back when they return.
test('GeoCode: a refresh keeps the quota shown until the new one comes', async () => {
  answer = { ok: true, value: QUOTA };
  useGeeQuota.getState().refresh('majestic');
  await answered();
  answer = { ok: true, value: { ...QUOTA, usedSeconds: 30 * HOUR } };
  useGeeQuota.getState().refresh('majestic');
  const during = useGeeQuota.getState().entry;
  expect(rows(during).first.text).toBe(TEXT.used('25.2', '150'));
  expect(rows(during).busy).toBe(true);
  await answered();
  expect(rows(useGeeQuota.getState().entry).first.text).toBe(TEXT.used('30', '150'));
});

// Guards against every opening of the status card asking Google again, and against showing another project's quota.
test('GeoCode: the quota is asked once in five minutes for a project, and again for another', async () => {
  answer = { ok: true, value: QUOTA };
  useGeeQuota.getState().ensure('majestic');
  await answered();
  useGeeQuota.getState().ensure('majestic');
  expect(calls).toBe(1);
  useGeeQuota.setState((state) => ({ entry: state.entry && { ...state.entry, at: Date.now() - 6 * 60 * 1000 } }));
  useGeeQuota.getState().ensure('majestic');
  expect(calls).toBe(2);
  await answered();
  useGeeQuota.getState().ensure('other');
  expect(calls).toBe(3);
  expect(useGeeQuota.getState().entry?.quota).toBeUndefined();
});

// Guards against a failure standing for five minutes after it is put right, as by enabling a service, and against
// one project's quota filed as another's when GeoEngine was configured anew meanwhile.
test('GeoCode: a failure is asked again as a view opens, and an answer goes under the project it is for', async () => {
  answer = { ok: false, reason: 'Cloud Monitoring API is disabled' };
  useGeeQuota.getState().ensure('majestic');
  await answered();
  answer = { ok: true, value: { ...QUOTA, project: 'other' } };
  useGeeQuota.getState().ensure('majestic');
  expect(calls).toBe(2);
  await answered();
  expect(useGeeQuota.getState().entry?.project).toBe('other');
});
