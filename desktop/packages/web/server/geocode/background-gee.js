import path from 'node:path';
import { z } from 'zod';

import { unwrapOpenCodeResponse } from '../lib/opencode/response-envelope.js';

// As the kernel lists Earth Engine runs in the background (kernel/packages/core/src/geocode/geerun-rpc.ts); the interface
// reads the same in desktop/packages/ui/src/geocode/geeRunsRpc.ts.
const runsSchema = z.object({
  output: z.object({
    runs: z.array(z.object({ sessionID: z.string(), description: z.string(), startedAt: z.number(), directory: z.string() })),
  }),
});

/**
 * Adds the kernel's Earth Engine runs in the background to the commands running in a directory, as the same kind of
 * entry: an agent waits on such a run as on a command, and the kernel's shell list does not hold it. Null when either
 * list could not be read, as for the commands alone.
 */
export const withRunningGeeRuns = (fetchRunningShells, { buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl = fetch, requestSignal }) =>
  async (directory) => {
    const shells = await fetchRunningShells(directory);
    if (!shells) return null;
    const response = await fetchImpl(buildOpenCodeUrl('/api/rpc/geocode.geeruns/list', ''), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...getOpenCodeAuthHeaders() },
      body: JSON.stringify({ input: {} }),
      // The probe's own: its time limit and its caller's abort, as for the commands.
      signal: requestSignal(),
    }).catch(() => null);
    if (!response?.ok) return null;
    const parsed = runsSchema.safeParse(unwrapOpenCodeResponse(await response.json().catch(() => null)));
    if (!parsed.success) return null;
    const runs = parsed.data.output.runs.filter((run) => path.relative(path.resolve(run.directory), path.resolve(directory)) === '');
    return [...shells, ...runs.map((run) => ({ sessionID: run.sessionID, command: run.description, startedAt: run.startedAt }))];
  };
