import { z } from 'zod';

/** As the kernel lists Earth Engine runs in the background (`kernel/packages/core/src/geocode/geerun-rpc.ts`). */
export const geeRunsSnapshot = z.object({
  revision: z.number(),
  runs: z.array(z.object({ id: z.string(), sessionID: z.string(), description: z.string(), startedAt: z.number() })),
});

export type GeeRunsSnapshot = z.infer<typeof geeRunsSnapshot>;

export const geeRunsRpc = {
  id: 'geocode.geeruns',
  methods: {
    list: { input: z.object({}), output: geeRunsSnapshot },
    stop: { input: z.object({ id: z.string() }), output: z.void() },
  },
  events: { changed: { schema: geeRunsSnapshot } },
} as const;
