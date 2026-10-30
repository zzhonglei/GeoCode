import { expect, test } from 'bun:test';
import fs from 'node:fs';

import { runSnapshotRef } from '@/lib/multirun/keep';

// Guards against the interface naming a run's snapshot in a way the server refuses, which fails every snapshot of a run.
test('GeoCode: the server accepts the snapshot refs the interface names', () => {
  const source = fs.readFileSync(new URL('../../../web/server/lib/git/service.js', import.meta.url), 'utf8');
  const pattern = new RegExp(source.match(/const RUN_SNAPSHOT_REF_PATTERN = \/(.+)\/;/)?.[1] ?? '$^');
  const ref = runSnapshotRef({ key: 'run', groupSlug: 'Taipei NDVI, 2026', lanes: [], fusions: [] }, 'ses_01K/abc');
  expect(pattern.test(ref)).toBe(true);
});
