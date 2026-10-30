import { z } from 'zod';

import type { Locale } from '@/lib/i18n';
import type { Part, ToolPart } from '@/lib/opencode/model';

import type { GeoTool } from './geoTools';
import { type Kind, OSM_STEPS, osmText, type OsmStep, type OsmText } from './osmText';
import { descriptionOf, wasDeclined, wasInterrupted } from './runLines';

/** The OSM tools, each call a row of its own. */
const OSM_TOOLS = ['osmsearch', 'osmprobe', 'osmgetobjects', 'osmgetfeatures'] as const satisfies readonly GeoTool[];

type OsmTool = (typeof OSM_TOOLS)[number];

export const isOsmTool = (name: string): name is OsmTool => OSM_TOOLS.some((tool) => tool === name);

/** How long a download may go without progress before its row says how long it has been waiting. */
const WAITING_AFTER_S = 30;

/** The steps a request waits on a server in. */
const NETWORK: readonly OsmStep[] = ['area', 'count', 'download'];

const filled = z.string().trim().min(1).optional().catch(undefined);
const list = z.array(z.string()).optional().catch(undefined);
const callInput = z
  .object({ name: filled, context: filled, category: filled, term: filled, tags: list, keys: list })
  .catch({});

/** How a call failed, as the kernel kept it: its kind, the server's words, and how long a stalled call waited. */
const failure = z.object({
  code: z.string(),
  said: z.string().optional().catch(undefined),
  seconds: z.number().optional().catch(undefined),
});

type NoteTone = 'info' | 'warning' | 'error';

/** A sentence in the interface's language, with what a server said under it when there is anything. */
export type Note = { readonly tone: NoteTone; readonly text: string; readonly said?: string };

/** A number as the rows write it, with thousands separators whatever the interface's language. */
export const count = (value: number) => value.toLocaleString('en-US');

const stateOf = (part: ToolPart) => {
  const state = part.state;
  return {
    running: state.status === 'pending' || state.status === 'running',
    error: state.status === 'error' ? state.error : undefined,
    metadata: 'metadata' in state ? (state.metadata ?? {}) : {},
    end:
      !(state.status === 'pending' || state.status === 'running') && 'time' in state && 'end' in state.time
        ? state.time.end
        : undefined,
  };
};

/**
 * How a call ended in an error: as the kernel kept its failure, else declined or interrupted, else in the kernel's
 * words.
 */
const failureNote = (
  words: OsmText,
  failed: z.infer<typeof failure> | undefined,
  error: string,
  download: boolean,
): Note => {
  if (!failed) {
    if (wasDeclined(error)) return { tone: 'error', text: words.failures.declined };
    if (wasInterrupted(error)) {
      return { tone: 'error', text: download ? words.failures.interruptedDownload : words.failures.interrupted };
    }
    return { tone: 'error', text: words.failures.other, said: error };
  }
  // GeoEngine always says how long a stalled call went without progress.
  if (failed.code === 'stalled' && failed.seconds !== undefined) {
    const minutes = Math.round(failed.seconds / 60);
    return {
      tone: 'error',
      text: download ? words.failures.stalledDownload(minutes) : words.failures.stalled(minutes),
    };
  }
  if (failed.code === 'unanswered') return { tone: 'error', text: words.failures.unanswered };
  if (failed.code === 'timeout') return { tone: 'error', text: words.failures.timeout };
  if (failed.code === 'refused') return { tone: 'error', text: words.failures.refused, said: failed.said };
  if (failed.code === 'invalid' || failed.code === 'invalid-params') {
    return { tone: 'error', text: words.failures.invalid, said: failed.said };
  }
  if (failed.code === 'too-large') return { tone: 'error', text: words.failures.tooLarge };
  if (failed.code === 'unwritable') return { tone: 'error', text: words.failures.unwritable, said: failed.said };
  if (failed.code === 'not-ready') return { tone: 'error', text: words.failures.notReady };
  return { tone: 'error', text: words.failures.other };
};

// --- Search ---

const candidate = z.object({
  id: z.string(),
  kind: z.enum(['point', 'line', 'area']).catch('point'),
  size: z.tuple([z.number(), z.number()]).nullable().catch(null),
  preset: z.string().nullable().catch(null),
  category: z.string().nullable().catch(null),
  name: z.string().nullable().catch(null),
  name_en: z.string().nullable().catch(null),
  location: z.string().nullable().catch(null),
  transit: z.boolean().catch(false),
});

const searchMetadata = z.object({
  found: z
    .object({
      context: z.string().nullable().catch(null),
      context_found: z.boolean().nullable().catch(null),
      category: z.string().nullable().catch(null),
      fallback: z.boolean().catch(false),
      incomplete: z.boolean().catch(false),
      candidates: z.array(candidate).catch([]),
    })
    .optional()
    .catch(undefined),
  failure: failure.optional().catch(undefined),
});

export type Candidate = {
  readonly id: string;
  readonly kind: Kind;
  readonly name: string;
  readonly nameEn?: string;
  readonly what: string;
  readonly where?: string;
  readonly size?: string;
  /** A stop or route named after a place, shown fainter. */
  readonly transit: boolean;
};

/** What a search's row shows: notes on how the search went, then its candidates, best first. */
export const osmSearchView = (part: ToolPart, locale: Locale) => {
  const words = osmText(locale);
  const { running, error, metadata } = stateOf(part);
  const input = callInput.parse(part.state.input);
  const parsed = searchMetadata.safeParse(metadata).data;
  const found = parsed?.found;
  const notes: Note[] = [];
  if (error !== undefined) notes.push(failureNote(words, parsed?.failure, error, false));
  if (found?.context && found.context_found === false) {
    notes.push({ tone: 'info', text: words.contextMissing(found.context) });
  }
  if (found?.incomplete) notes.push({ tone: 'warning', text: words.incomplete });
  if (found?.fallback && found.candidates.length) {
    notes.push({ tone: 'info', text: words.fallback(found.category ?? '') });
  }
  if (found && !found.candidates.length) notes.push({ tone: 'info', text: words.nothingFound });
  const candidates = (found?.candidates ?? []).map(
    (item): Candidate => ({
      id: item.id,
      kind: item.kind,
      name: item.name ?? item.name_en ?? item.id,
      nameEn: item.name && item.name_en && item.name_en !== item.name ? item.name_en : undefined,
      what: item.preset ?? item.category ?? words.kinds[item.kind],
      where: item.location ?? undefined,
      size: item.kind !== 'point' && item.size ? `${item.size[0]} × ${item.size[1]} km` : undefined,
      transit: item.transit,
    }),
  );
  return {
    title: words.search,
    description: [input.name, input.context, input.category].filter(Boolean).join(' · '),
    running,
    bad: error !== undefined,
    notes,
    candidates,
  };
};

// --- Probe ---

const looked = z.union([
  z.object({
    term: z.string(),
    rows: z.array(
      z.object({
        filter: z.string(),
        why: z.enum(['preset', 'added', 'deprecated']).catch('preset'),
        total: z.number(),
      }),
    ),
    uncounted: z.array(z.string()).catch([]),
    remark: z.string().nullable().optional().catch(null),
  }),
  z.object({
    rows: z.array(z.object({ filter: z.string(), total: z.number() })),
    uncounted: z.array(z.string()).catch([]),
    together: z.object({ total: z.number() }).nullable().catch(null),
    remark: z.string().nullable().catch(null),
  }),
  z.object({
    keys: z.array(
      z.object({
        key: z.string(),
        features: z.number(),
        values: z.array(z.tuple([z.string(), z.number()])),
        others: z.number(),
        others_features: z.number(),
      }),
    ),
    sampled: z.boolean().catch(false),
    remark: z.string().nullable().catch(null),
  }),
]);

const probeMetadata = z.object({
  looked: looked.optional().catch(undefined),
  failure: failure.optional().catch(undefined),
  queued: z.boolean().catch(false),
});

/** How many of the values a look at keys shows before the rest are folded away. */
const SHOWN_VALUES = 8;

type Bar = { readonly label: string; readonly count: number; readonly chip?: string };

/** One set of counts with a bar each, the longest at the most; those with none are named apart. */
export type Counts = {
  readonly heading?: string;
  readonly bars: readonly Bar[];
  readonly shown: number;
  readonly rest?: { readonly label: string; readonly count: number };
  readonly zeros: readonly string[];
  /** Those the server stopped before counting. */
  readonly uncounted?: readonly string[];
  readonly foot?: string;
};

/** What a look's row shows: that it waits for the call before it while it does; then its counts, and how it went. */
export const osmProbeView = (part: ToolPart, locale: Locale) => {
  const words = osmText(locale);
  const { running, error, metadata } = stateOf(part);
  const input = callInput.parse(part.state.input);
  const parsed = probeMetadata.safeParse(metadata).data;
  const result = parsed?.looked;
  const groups: Counts[] = [];
  const notes: Note[] = [];
  if (error !== undefined) notes.push(failureNote(words, parsed?.failure, error, false));
  if (result && 'term' in result) {
    if (!result.rows.length && !result.uncounted.length) notes.push({ tone: 'info', text: words.noTerm(result.term) });
    else {
      const chip = { preset: undefined, added: words.added, deprecated: words.deprecated };
      const bars = result.rows
        .filter((row) => row.total > 0)
        .map((row) => ({ label: row.filter, count: row.total, chip: chip[row.why] }));
      groups.push({
        bars,
        shown: bars.length,
        zeros: result.rows.filter((row) => row.total === 0).map((row) => row.filter),
        uncounted: result.uncounted,
      });
    }
  } else if (result && 'rows' in result) {
    const bars = result.rows.filter((row) => row.total > 0).map((row) => ({ label: row.filter, count: row.total }));
    groups.push({
      bars,
      shown: bars.length,
      zeros: result.rows.filter((row) => row.total === 0).map((row) => row.filter),
      uncounted: result.uncounted,
      // Not the sum: a feature may carry several of the tags.
      foot: result.together ? words.anyOf(count(result.together.total)) : undefined,
    });
  } else if (result) {
    for (const key of result.keys) {
      const bars = key.values.map(([value, total]) => ({ label: value, count: total }));
      groups.push({
        heading: result.keys.length > 1 ? `${key.key} · ${words.keyFeatures(count(key.features))}` : undefined,
        bars,
        shown: Math.min(bars.length, SHOWN_VALUES),
        rest: key.others ? { label: words.others(key.others), count: key.others_features } : undefined,
        zeros: [],
      });
    }
    if (result.sampled) notes.push({ tone: 'info', text: words.sampled });
  }
  if (result?.remark) notes.push({ tone: 'warning', text: words.stoppedEarly, said: result.remark });
  return {
    title: words.probe,
    description: input.term ?? input.tags?.join(', ') ?? (input.keys ? words.values(input.keys.join(', ')) : ''),
    running,
    doing: running && parsed?.queued ? words.queued : undefined,
    bad: error !== undefined,
    groups,
    notes,
  };
};

// --- Downloads ---

const gap = z.union([
  z.object({ part: z.array(z.number()), said: z.string() }),
  z.object({ absent: z.array(z.string()) }),
  z.object({ unassembled: z.array(z.string()) }),
  z.object({ undownloaded: z.array(z.string()), code: z.literal('stalled'), seconds: z.number() }),
  z.object({ undownloaded: z.array(z.string()), code: z.literal('unanswered') }),
  z.object({ said: z.string() }),
]);

const downloadMetadata = z.object({
  started: z.number().optional().catch(undefined),
  steps: z
    .array(
      z.object({
        step: z.enum(OSM_STEPS),
        started: z.number(),
        ended: z.number().optional().catch(undefined),
      }),
    )
    .catch([]),
  counted: z.object({ features: z.number().nullable(), parts: z.number() }).optional().catch(undefined),
  part: z.object({ part: z.number(), parts: z.number() }).optional().catch(undefined),
  received: z.number().optional().catch(undefined),
  progressed: z.number().optional().catch(undefined),
  asking: z.boolean().catch(false),
  arriving: z.boolean().catch(false),
  busy: z.boolean().catch(false),
  queued: z.boolean().catch(false),
  result: z
    .union([
      z.object({
        path: z.string(),
        layers: z.record(z.string(), z.number()),
        timestamp: z.string(),
        fields: z.array(z.string()),
        gaps: z.array(gap).catch([]),
      }),
      z.object({ empty: z.literal(true), gaps: z.array(gap).catch([]) }),
      z.object({ refused: z.number(), limit: z.number() }),
    ])
    .optional()
    .catch(undefined),
  failure: failure.optional().catch(undefined),
});

export type StepRow = {
  readonly step: OsmStep;
  readonly label: string;
  readonly state: 'done' | 'now' | 'later';
  readonly info?: string;
  /** The share of the parts downloaded, in percent. */
  readonly share?: number;
  readonly time?: string;
  readonly warn?: string;
};

export type FileCard = {
  readonly name: string;
  readonly folder: string;
  readonly layers: readonly { readonly kind: Kind; readonly count: string; readonly label: string }[];
  readonly asOf: string;
  readonly columns: string;
  readonly fields: string;
};

/** The layers as a download writes them, with what each holds. */
const LAYERS = [
  ['points', 'point'],
  ['lines', 'line'],
  ['polygons', 'area'],
] as const;

/** As the kernel says when OSM's data is from: "2026-10-25 08:00 UTC". */
const minute = (time: string) => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(time);
  return match ? `${match[1]} ${match[2]} UTC` : time;
};

const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const seconds = (from: number, to: number) => `${Math.max(0.1, (to - from) / 1000).toFixed(1)}s`;

const gapNote = (words: OsmText, missing: z.infer<typeof gap>): Note => {
  if ('part' in missing) {
    const [south, west, north, east] = missing.part;
    return { tone: 'warning', text: words.partMissing(`${south}, ${west} – ${north}, ${east}`), said: missing.said };
  }
  if ('absent' in missing) return { tone: 'warning', text: words.absent(missing.absent.join(', ')) };
  if ('unassembled' in missing) return { tone: 'warning', text: words.unassembled(missing.unassembled.join(', ')) };
  if ('undownloaded' in missing) {
    const minutes = missing.code === 'stalled' ? Math.round(missing.seconds / 60) : undefined;
    return { tone: 'warning', text: words.undownloaded(missing.undownloaded.join(', '), minutes) };
  }
  return { tone: 'warning', text: words.serverStopped, said: missing.said };
};

/**
 * What a download's row shows at `now`: while it runs, its step on the row and every step when opened; once it has
 * ended, how many features it wrote on the row and its file when opened, or why there is none.
 */
export const osmDownloadView = (part: ToolPart, locale: Locale, now: number) => {
  const words = osmText(locale);
  const { running, error, metadata, end } = stateOf(part);
  const input = callInput.parse(part.state.input);
  const state = downloadMetadata.safeParse(metadata).data;
  const order = part.tool === 'osmgetfeatures' ? OSM_STEPS : OSM_STEPS.slice(2);
  const current = state?.steps.at(-1);
  const quiet = state?.progressed === undefined ? 0 : Math.max(0, Math.floor((now - state.progressed) / 1000));
  const network = current !== undefined && current.ended === undefined && NETWORK.includes(current.step);
  // While a query is out and its answer has not begun to arrive, the server is working on it: what has come so far is
  // only the answer's head, or nothing.
  const querying = network && state?.asking && !state.arriving ? words.querying(words.duration(quiet)) : undefined;
  // Said on the step, and on the row: waiting for the call before it, for a free server, or for a server gone silent.
  const blocked = !running
    ? undefined
    : state?.queued
      ? words.queued
      : state?.busy
        ? words.busy
        : network && !querying && quiet >= WAITING_AFTER_S
          ? words.waiting(words.duration(quiet))
          : undefined;
  const held = blocked ?? (querying && quiet >= WAITING_AFTER_S ? querying : undefined);
  const downloading = current?.step === 'download' && current.ended === undefined ? state?.part : undefined;
  const share = downloading ? Math.round(((downloading.part - 1) / downloading.parts) * 100) : undefined;
  const received = state?.received === undefined ? undefined : words.received(size(state.received));
  const onPart = downloading ? words.part(downloading.part, downloading.parts) : undefined;

  const steps = running
    ? order.map((name): StepRow => {
        const entry = state?.steps.find((step) => step.step === name);
        const status = entry === undefined ? 'later' : entry.ended === undefined ? 'now' : 'done';
        const counted = state?.counted;
        const info =
          name === 'count' && status === 'done' && counted
            ? words.counted(counted.features === null ? undefined : count(counted.features), counted.parts)
            : status === 'now' && querying
              ? [onPart, querying].filter(Boolean).join(' · ')
              : name === 'download' && status !== 'later'
                ? [onPart, received].filter(Boolean).join(' · ') || undefined
                : undefined;
        return {
          step: name,
          label: words.steps[name],
          state: status,
          info,
          share: name === 'download' && status === 'now' ? share : undefined,
          time: status === 'done' && entry?.ended !== undefined ? seconds(entry.started, entry.ended) : undefined,
          warn: status === 'now' ? blocked : undefined,
        };
      })
    : undefined;

  const notes: Note[] = [];
  let file: FileCard | undefined;
  let added: { count: string; hint: string } | undefined;
  let refused = false;
  const result = state?.result;
  if (error !== undefined) notes.push(failureNote(words, state?.failure, error, true));
  else if (result && 'path' in result) {
    const total = Object.values(result.layers).reduce((sum, features) => sum + features, 0);
    added = { count: count(total), hint: words.features(count(total)) };
    const pieces = result.path.split(/[\\/]/);
    file = {
      name: pieces.at(-1) ?? result.path,
      folder: pieces.length > 1 ? `${pieces.slice(0, -1).join('/')}/` : '',
      layers: LAYERS.filter(([layer]) => result.layers[layer]).map(([layer, kind]) => ({
        kind,
        count: count(result.layers[layer]),
        label: words.layers[layer],
      })),
      asOf: words.asOf(minute(result.timestamp)),
      columns: words.columns(result.fields.length),
      fields: result.fields.join(', '),
    };
    notes.push(...result.gaps.map((missing) => gapNote(words, missing)));
  } else if (result && 'empty' in result) {
    // Nothing from a server that stopped early, or only objects whose geometry could not be assembled, is not that OSM
    // has none: the gaps say what happened.
    if (!result.gaps.some((gap) => 'said' in gap || 'unassembled' in gap)) {
      notes.push({
        tone: 'info',
        text: part.tool === 'osmgetfeatures' ? words.empty((input.tags ?? []).join(', ')) : words.emptyObjects,
      });
    }
    notes.push(...result.gaps.map((missing) => gapNote(words, missing)));
  } else if (result) {
    refused = true;
    notes.push({ tone: 'error', text: words.refused(count(result.refused), count(result.limit)) });
  }

  return {
    title: descriptionOf(part.state.input) ?? words.download,
    running,
    bad: error !== undefined || refused,
    start: state?.started,
    end,
    doing: running
      ? (held ??
        (downloading
          ? words.downloadingPart(downloading.part, downloading.parts)
          : current
            ? words.doing[current.step]
            : undefined))
      : undefined,
    percent: running ? share : undefined,
    added,
    steps,
    file,
    notes,
  };
};

// --- Permission cards ---

const OSM_ID = /^[nwr]\d+$/i;

/** Whether a place is an OSM id, as R10958940. */
export const isOsmId = (place: string) => OSM_ID.test(place);

type OsmArea =
  | { readonly kind: 'objects'; readonly places: readonly string[] }
  | { readonly kind: 'around'; readonly places: readonly string[]; readonly meters: string }
  | { readonly kind: 'box'; readonly from: string; readonly to: string }
  | { readonly kind: 'file'; readonly path: string; readonly layer: string | undefined }
  | { readonly kind: 'text'; readonly text: string };

/**
 * An area as GeoAgent wrote it, taken apart for a permission card to word: the places are OSM
 * ids or a point as "latitude, longitude"; an area written otherwise stays as written.
 */
export const osmArea = (area: string): OsmArea => {
  const text = area.trim();
  const lower = text.toLowerCase();
  if (lower.startsWith('file:')) {
    const [file, layer] = text.slice('file:'.length).split('|');
    const name = layer?.startsWith('layername=') ? layer.slice('layername='.length) : undefined;
    return { kind: 'file', path: file.trim(), layer: name };
  }
  const parts = text.slice(text.indexOf(':') + 1).split(',').map((value) => value.trim());
  if (lower.startsWith('bbox:') && parts.length === 4) {
    return { kind: 'box', from: `${parts[0]}, ${parts[1]}`, to: `${parts[2]}, ${parts[3]}` };
  }
  if (lower.startsWith('around:') && parts.length >= 2) {
    const places = parts.slice(0, -1);
    const meters = parts[parts.length - 1];
    if (places.every(isOsmId)) return { kind: 'around', places: places.map((id) => id.toUpperCase()), meters };
    if (places.length === 2) return { kind: 'around', places: [`${places[0]}, ${places[1]}`], meters };
  }
  const ids = text.split(',').map((value) => value.trim());
  return ids.every(isOsmId) ? { kind: 'objects', places: ids.map((id) => id.toUpperCase()) } : { kind: 'text', text };
};

/** The names of the OSM objects the session's searches found, by id, for a permission card to name them by. */
export const osmNames = (parts: readonly Part[]) => {
  const names: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'tool' || part.tool !== 'osmsearch' || part.state.status !== 'completed') continue;
    const found = searchMetadata.safeParse(part.state.metadata ?? {}).data?.found;
    for (const candidate of found?.candidates ?? []) {
      const name = candidate.name ?? candidate.name_en;
      if (name) names[candidate.id] = name;
    }
  }
  return names;
};
