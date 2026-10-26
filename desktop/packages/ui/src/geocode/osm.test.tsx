import { describe, expect, test } from 'bun:test';

import type { Metadata, ToolPart, ToolState } from '@/lib/opencode/model';

import { osmText } from './osmText';
import { osmDownloadView, osmProbeView, osmSearchView } from './osmView';

const call = (tool: string, state: ToolState): ToolPart => ({
  id: `call_${tool}`,
  sessionID: 'ses_1',
  messageID: 'msg_a',
  type: 'tool',
  callID: `call_${tool}`,
  tool,
  state,
});

const NOW = 1_000_000;
const FEATURES = {
  area: 'R10958940',
  tags: ['amenity', 'shop'],
  output: 'data/osm/ntpu_poi.gpkg',
  description: '下载台北大学周边 POI',
};

const running = (metadata: Metadata) =>
  call('osmgetfeatures', { status: 'running', input: FEATURES, metadata, time: { start: NOW - 100_000 } });

const ended = (metadata: Metadata) =>
  call('osmgetfeatures', {
    status: 'completed',
    input: FEATURES,
    output: 'Wrote …',
    metadata,
    time: { start: NOW - 100_000, end: NOW },
  });

const failed = (tool: string, error: string, metadata: Metadata = {}) =>
  call(tool, { status: 'error', input: FEATURES, error, metadata, time: { start: NOW - 100_000, end: NOW } });

/** A download in its third part of four, last making progress `quiet` seconds ago. */
const downloading = (quiet: number, busy = false) =>
  running({
    description: FEATURES.description,
    started: NOW - 90_000,
    steps: [
      { step: 'area', started: NOW - 90_000, ended: NOW - 89_600 },
      { step: 'count', started: NOW - 89_600, ended: NOW - 85_200 },
      { step: 'download', started: NOW - 85_200 },
    ],
    counted: { features: 1290, parts: 4 },
    part: { part: 3, parts: 4 },
    received: 6.4 * 1024 * 1024,
    progressed: NOW - quiet * 1000,
    busy,
  });

describe("GeoCode: the OSM tools' rows", () => {
  const en = osmText('en');

  // Guards against a stalled download looking like one still moving, and a busy server like a silent one.
  test('a download says its part as it goes, and how long it has waited once a server keeps it waiting', () => {
    const moving = osmDownloadView(downloading(5), 'en', NOW);
    expect(moving.doing).toBe(en.downloadingPart(3, 4));
    expect(moving.percent).toBe(50);
    expect(moving.steps?.map((step) => step.state)).toEqual(['done', 'done', 'now', 'later', 'later']);
    expect(moving.steps?.[1]).toMatchObject({ info: en.counted('1,290', 4) });
    expect(moving.steps?.[2]).toMatchObject({
      info: `${en.part(3, 4)} · ${en.received('6.4 MB')}`,
      share: 50,
      warn: undefined,
    });

    const waiting = osmDownloadView(downloading(80), 'en', NOW);
    expect(waiting.doing).toBe(en.waiting(en.duration(80)));
    expect(waiting.steps?.[2].warn).toBe(en.waiting(en.duration(80)));
    expect(osmDownloadView(downloading(80, true), 'en', NOW).doing).toBe(en.busy);
  });

  test('a finished download says how many features it wrote, and opens to its file and what it misses', () => {
    const view = osmDownloadView(
      ended({
        description: FEATURES.description,
        started: NOW - 90_000,
        steps: [],
        busy: false,
        result: {
          path: 'data/osm/ntpu_poi.gpkg',
          layers: { points: 1234, polygons: 56 },
          timestamp: '2026-10-25T08:00:00Z',
          fields: ['osm_id', 'name', 'category', 'amenity'],
          gaps: [{ part: [24.93, 121.36, 24.95, 121.38], said: 'runtime error: Query timed out' }],
        },
      }),
      'zh-CN',
      NOW,
    );
    const zh = osmText('zh-CN');
    expect(view).toMatchObject({
      title: FEATURES.description,
      bad: false,
      added: { count: '1,290' },
      steps: undefined,
    });
    expect(view.file).toEqual({
      name: 'ntpu_poi.gpkg',
      folder: 'data/osm/',
      layers: [
        { kind: 'point', count: '1,234', label: zh.layers.points },
        { kind: 'area', count: '56', label: zh.layers.polygons },
      ],
      asOf: zh.asOf('2026-10-25 08:00 UTC'),
      columns: zh.columns(4),
      fields: 'osm_id, name, category, amenity',
    });
    expect(view.notes).toEqual([
      {
        tone: 'warning',
        text: zh.partMissing('24.93, 121.36 – 24.95, 121.38'),
        said: 'runtime error: Query timed out',
      },
    ]);
  });

  // Guards against the user reading the model's English, or losing what the server said.
  test("a failed call says why in the interface's language, with the server's own words under it", () => {
    const zh = osmText('zh-CN');
    const stalled = osmDownloadView(
      failed('osmgetfeatures', 'No progress for 5 minutes: …', { failure: { code: 'stalled', seconds: 300 } }),
      'zh-CN',
      NOW,
    );
    expect(stalled).toMatchObject({ bad: true, notes: [{ tone: 'error', text: zh.failures.stalledDownload(5) }] });
    const refused = osmProbeView(
      failed('osmprobe', "OpenStreetMap's Overpass service refused the query: …", {
        failure: { code: 'refused', said: 'line 1: parse error: Invalid regular expression' },
      }),
      'zh-CN',
    );
    expect(refused.notes).toEqual([
      { tone: 'error', text: zh.failures.refused, said: 'line 1: parse error: Invalid regular expression' },
    ]);
    expect(osmDownloadView(failed('osmgetobjects', 'Tool execution interrupted'), 'zh-CN', NOW).notes).toEqual([
      { tone: 'error', text: zh.failures.interruptedDownload },
    ]);
    expect(osmDownloadView(failed('osmgetobjects', 'The user declined this tool call'), 'zh-CN', NOW).notes).toEqual([
      { tone: 'error', text: zh.failures.declined },
    ]);
    const stopped = osmDownloadView(
      ended({ result: { empty: true, gaps: [{ said: 'runtime error: Query run out of memory' }], timestamp: null } }),
      'zh-CN',
      NOW,
    );
    // Guards against nothing from a server that stopped early reading as OSM having nothing.
    expect(stopped.notes.map((note) => note.text)).not.toContain(zh.empty(FEATURES.tags.join(', ')));
    expect(stopped.notes).toHaveLength(1);
    const unassembled = osmDownloadView(
      ended({ result: { empty: true, gaps: [{ unassembled: ['R1'] }], timestamp: null } }),
      'zh-CN',
      NOW,
    );
    // Guards against objects whose rings do not close reading as objects OSM lacks.
    expect(unassembled.notes).toEqual([{ tone: 'warning', text: zh.unassembled('R1') }]);
    const refusedDownload = osmDownloadView(ended({ result: { refused: 3912406, limit: 1000000 } }), 'en', NOW);
    expect(refusedDownload).toMatchObject({
      bad: true,
      added: undefined,
      notes: [{ text: en.refused('3,912,406', '1,000,000') }],
    });
  });

  test('a search lists its candidates as found, with how the search went before them', () => {
    const candidate = (fields: Metadata) => ({
      id: 'R10958940',
      kind: 'area',
      size: [1.1, 0.9],
      preset: 'University',
      category: 'amenity=university',
      name: '國立臺北大學',
      name_en: 'National Taipei University',
      location: 'New Taipei, Taiwan',
      transit: false,
      ...fields,
    });
    const view = osmSearchView(
      call('osmsearch', {
        status: 'completed',
        input: { name: '國立臺北大學', context: '新北市' },
        output: '…',
        metadata: {
          found: {
            context: '新北市',
            context_found: true,
            category: null,
            fallback: false,
            incomplete: true,
            candidates: [
              candidate({}),
              candidate({
                id: 'N4893210537',
                kind: 'point',
                size: null,
                preset: 'Bus Stop',
                name: '臺北大學',
                name_en: '臺北大學',
                transit: true,
              }),
            ],
          },
        },
        time: { start: NOW - 3000, end: NOW },
      }),
      'en',
    );
    expect(view.description).toBe('國立臺北大學 · 新北市');
    expect(view.notes).toEqual([{ tone: 'warning', text: en.incomplete }]);
    expect(view.candidates).toEqual([
      {
        id: 'R10958940',
        kind: 'area',
        name: '國立臺北大學',
        nameEn: 'National Taipei University',
        what: 'University',
        where: 'New Taipei, Taiwan',
        size: '1.1 × 0.9 km',
        transit: false,
      },
      {
        id: 'N4893210537',
        kind: 'point',
        name: '臺北大學',
        nameEn: undefined,
        what: 'Bus Stop',
        where: 'New Taipei, Taiwan',
        size: undefined,
        transit: true,
      },
    ]);
  });

  test('a look names the tagging found nowhere apart, and gives the features meeting any tag, not their sum', () => {
    const looked = (result: Metadata) =>
      osmProbeView(
        call('osmprobe', {
          status: 'completed',
          input: { area: 'R1', tags: ['amenity', 'shop'] },
          output: '…',
          metadata: { looked: result },
          time: { start: 0, end: 1 },
        }),
        'en',
      );
    const term = looked({
      area: 'R1',
      term: 'hospital',
      rows: [
        {
          filter: 'amenity=hospital',
          why: 'preset',
          total: 3,
          nodes: 0,
          ways: 3,
          relations: 0,
          preset: 'Hospital Grounds',
        },
        {
          filter: 'healthcare=hospital',
          why: 'added',
          total: 2,
          nodes: 0,
          ways: 2,
          relations: 0,
          preset: 'Hospital Grounds',
        },
        { filter: 'healthcare=centre', why: 'deprecated', total: 0, nodes: 0, ways: 0, relations: 0, preset: 'Clinic' },
      ],
    });
    expect(term.groups).toEqual([
      {
        bars: [
          { label: 'amenity=hospital', count: 3, chip: undefined },
          { label: 'healthcare=hospital', count: 2, chip: en.added },
        ],
        shown: 2,
        zeros: ['healthcare=centre'],
        uncounted: [],
      },
    ]);
    const tags = looked({
      area: 'R1',
      rows: [
        { filter: 'amenity', total: 612, nodes: 0, ways: 0, relations: 0 },
        { filter: 'shop', total: 498, nodes: 0, ways: 0, relations: 0 },
      ],
      together: { total: 1000, nodes: 0, ways: 0, relations: 0 },
      remark: null,
    });
    expect(tags.groups[0].foot).toBe(en.anyOf('1,000'));
    const uncounted = looked({
      area: 'R1',
      term: 'hospital',
      rows: [],
      uncounted: ['amenity=hospital', 'healthcare=hospital'],
      remark: 'runtime error: Query timed out',
    });
    // Guards against a word the server stopped before counting reading as one OSM has no tags for.
    expect(uncounted.notes.map((note) => note.text)).not.toContain(en.noTerm('hospital'));
    expect(uncounted.groups[0].uncounted).toEqual(['amenity=hospital', 'healthcare=hospital']);
  });
});
