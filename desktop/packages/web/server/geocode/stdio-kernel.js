import { z } from 'zod';

// `opencode serve --stdio` prints a single JSON line with its URL once it listens.
const stdioReadySchema = z.object({ url: z.string().regex(/^https?:\/\//) });

export const readStdioReadyUrl = (line) => {
  try {
    const parsed = stdioReadySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data.url : null;
  } catch {
    return null;
  }
};
