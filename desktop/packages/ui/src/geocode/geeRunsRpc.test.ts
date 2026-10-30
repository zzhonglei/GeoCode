import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { z } from 'zod';

import { geeRunsRpc, geeRunsSnapshot } from './geeRunsRpc';

type Described = { properties?: Record<string, Described>; items?: Described };

const describe = (schema: z.ZodType) =>
  // SAFETY: only objects and arrays are described here, which JSON Schema writes with properties and items.
  z.toJSONSchema(schema) as Described;

// Guards against the two descriptions of the background runs drifting apart, which leaves the strip without its runs.
test('GeoCode: the interface describes the background runs as the kernel does', () => {
  const kernel = fs.readFileSync(new URL('../../../../../kernel/packages/core/src/geocode/geerun-rpc.ts', import.meta.url), 'utf8');
  const keys = (pattern: RegExp, key: RegExp) => [...(kernel.match(pattern)?.[1] ?? '').matchAll(key)].map((match) => match[1]);
  const fields = (described: Described | undefined) => Object.keys(described?.properties ?? {});
  const snapshot = describe(geeRunsSnapshot);
  expect(kernel).toContain(`id: "${geeRunsRpc.id}"`);
  expect(keys(/Run = Schema\.Struct\(\{([^}]*)\}/, /(\w+): Schema\./g)).toEqual(fields(snapshot.properties?.runs?.items));
  expect(keys(/Snapshot = Schema\.Struct\(\{([^}]*)\}/, /(\w+): Schema\./g)).toEqual(fields(snapshot));
  expect(keys(/methods: \{([\s\S]*?)\n {2}\},/, /^ {4}(\w+): /gm)).toEqual(Object.keys(geeRunsRpc.methods));
  expect(keys(/stop: \{ input: Schema\.Struct\(\{([^}]*)\}/, /(\w+): Schema\./g)).toEqual(fields(describe(geeRunsRpc.methods.stop.input)));
  expect(keys(/events: \{([^}]*)\}/, /(\w+): \{/g)).toEqual(Object.keys(geeRunsRpc.events));
});
