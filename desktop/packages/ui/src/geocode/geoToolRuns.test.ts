import { describe, expect, test } from 'bun:test';

import type { ChatMessageEntry } from '@/components/chat/lib/turns/types';
import type { Part, SyntheticMessage } from '@/lib/opencode/model';

import { GEO_TOOLS } from './geoTools';
import { geoToolRuns, hasGeoRow } from './geoToolRuns';

const read = (id: string): Part => ({
  id,
  sessionID: 'ses_1',
  messageID: 'msg_a',
  type: 'tool',
  callID: id,
  tool: 'readgeodata',
  state: { status: 'completed', input: { path: `/data/${id}.gpkg` }, output: '', metadata: {}, time: { start: 1, end: 2 } },
});

const text = (id: string, value: string): Part => ({ id, sessionID: 'ses_1', messageID: 'msg_a', type: 'text', text: value });

const reply = (id: string, parts: Part[]): ChatMessageEntry => ({
  info: { id, sessionID: 'ses_1', role: 'assistant', time: { created: 1 }, agent: 'build', providerID: 'p', modelID: 'm' },
  parts,
});

/** A plugin's notice, which upstream's timeline draws as a row of its own between the replies. */
const plugin: SyntheticMessage = {
  id: 'msg_notice',
  sessionID: 'ses_1',
  role: 'synthetic',
  time: { created: 2 },
  description: 'Waiting for quota reset',
  text: 'Retrying at 10:00.',
  metadata: { source: 'quota' },
};
const notice: ChatMessageEntry = { info: plugin, parts: [] };

/** The runs the calls belong to, by the call that stands for each. */
const rowsOf = (messages: ChatMessageEntry[]) =>
  [...new Set([...geoToolRuns(messages, false, false, new Map()).values()].map((run) => run.row))];

// Guards against geo calls merging across something the conversation shows between them, or parting at what it does not.
describe('GeoCode: which geo calls the conversation shows as one row', () => {
  test('a text of zero-width characters alone parts no calls, as it draws nothing', () => {
    expect(rowsOf([reply('msg_a', [read('a'), text('t', '​'), read('b')])])).toEqual(['b']);
  });

  test('a text that shows parts them', () => {
    expect(rowsOf([reply('msg_a', [read('a'), text('t', 'Next, the roads.'), read('b')])])).toEqual(['a', 'b']);
  });

  test("a notice the timeline draws between two replies parts their calls", () => {
    expect(rowsOf([reply('msg_a', [read('a')]), notice, reply('msg_b', [read('b')])])).toEqual(['a', 'b']);
  });
});

// Guards against a geo tool the kernel adds drawn as a generic tool row: the rows' list is written apart from GEO_TOOLS.
describe('GeoCode: the geo tools in the conversation', () => {
  test('each has rows of its own', () => {
    expect(GEO_TOOLS.filter((tool) => !hasGeoRow(tool))).toEqual([]);
  });
});
