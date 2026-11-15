import { z } from 'zod';

/** What the shell server sends when a folder a window shows changed on disk; folderChanged.test.ts holds it to the server's. */
export const FOLDER_CHANGED_EVENT = 'geocode:folder-changed';

/** `client` is the file tree that showed the folders, `directories` the folders as it spelled them. */
export const folderChangedEventSchema = z.object({ client: z.string(), directories: z.array(z.string()) });

export type FolderChangedEvent = { type: 'folder-changed' } & z.infer<typeof folderChangedEventSchema>;
