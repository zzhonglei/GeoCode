import { z } from 'zod';

import { isJumpListSessionId } from '../dock-menu.mjs';

// Windows' jump list opens an unread session with an argument of GeoCode's own, as the app takes no openchamber://
// link. The session link it stands for is made here, and only a link made here gets past handleDeepLinks.
const ARG_PREFIX = '--open-session=';
const made = new Set();

export const jumpListSessionArg = (sessionId) => `${ARG_PREFIX}${sessionId}`;

/** The session links a launch's arguments ask for, as the jump list would have linked them. */
export const jumpListSessionLinks = (argv) => z.array(z.unknown()).catch([]).parse(argv).flatMap((arg) => {
  const parsed = z.string().startsWith(ARG_PREFIX).safeParse(arg);
  const sessionId = parsed.success ? parsed.data.slice(ARG_PREFIX.length) : '';
  if (!isJumpListSessionId(sessionId)) return [];
  const link = `openchamber://session/${sessionId}?source=jump-list`;
  made.add(link);
  return [link];
});

export const isMadeJumpListLink = (link) => made.has(link);
