import path from 'node:path';
import { z } from 'zod';

import { unwrapOpenCodeResponse } from '../lib/opencode/response-envelope.js';

// As the kernel lists Earth Engine runs in the background (kernel/packages/core/src/geocode/geerun-rpc.ts); the interface
// reads the same in desktop/packages/ui/src/geocode/geeRunsRpc.ts.
const runsSchema = z.object({
  output: z.object({
    runs: z.array(z.object({ sessionID: z.string(), description: z.string(), directory: z.string() })),
  }),
});

/**
 * Adds the kernel's Earth Engine runs in the background to the commands running in a directory, as the same kind of
 * entry: an agent waits on such a run as on a command, and the kernel's shell list does not hold it. Null when either
 * list could not be read, as for the commands alone.
 *
 * A run reads as started now. A goal stops waiting for a command started before its round or more than 30 minutes ago,
 * taking it for a server left running; a run always ends (GeoEngine stops one that goes quiet), and a long export is
 * what it is for, so the goal waits for it to end, as the kernel's /goal does. The worktree cleanup waits for it too.
 */
export const withRunningGeeRuns = (fetchRunningShells, { buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl = fetch, requestSignal }) =>
  async (directory) => {
    const shells = await fetchRunningShells(directory);
    if (!shells) return null;
    const response = await fetchImpl(buildOpenCodeUrl('/api/rpc/geocode.geeruns/list', ''), {
      method: 'POST',
      // The folder's location, as for the commands: a request naming none makes the kernel start its own working
      // directory, the user's home, with its MCP servers. Any location lists every run.
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-opencode-directory': encodeURIComponent(directory),
        ...getOpenCodeAuthHeaders(),
      },
      body: JSON.stringify({ input: {} }),
      // The probe's own: its time limit and its caller's abort, as for the commands.
      signal: requestSignal(),
    }).catch(() => null);
    if (!response?.ok) return null;
    const parsed = runsSchema.safeParse(unwrapOpenCodeResponse(await response.json().catch(() => null)));
    if (!parsed.success) return null;
    const runs = parsed.data.output.runs.filter((run) => path.relative(path.resolve(run.directory), path.resolve(directory)) === '');
    const now = Date.now();
    return [...shells, ...runs.map((run) => ({ sessionID: run.sessionID, command: run.description, startedAt: now }))];
  };
