import { CHATS_SCOPE_PUBLIC_ID } from '../lib/scheduled-tasks/chats-scope.js';

// The id an agent knows Chats by. A model repeats the names it sees, so it gets GeoCode's; the interface and stored
// scheduled tasks keep upstream's, which is why it is swapped only where the agent tools call the control service.
export const MODEL_CHATS_ID = 'geocode:chats';

// Both sides are JSON on the wire. Only a value that is the id itself matches: inside a longer string its quotes are
// escaped.
const swap = (value, from, to) =>
  value === undefined ? value : JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(from), JSON.stringify(to)));

/** Runs a control action for an agent: its input and its result name Chats as the agent does. */
export const withModelChatsId = async (input, run) =>
  swap(await run(swap(input, MODEL_CHATS_ID, CHATS_SCOPE_PUBLIC_ID)), CHATS_SCOPE_PUBLIC_ID, MODEL_CHATS_ID);
