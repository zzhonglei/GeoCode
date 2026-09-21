/* --- GeoCode: `#name` substitution is not a desktop-shell surface (docs/DESKTOP.md §7.3). The picker already
 * renders nothing there and the server refuses its routes, but the caret trigger has to agree as well: a
 * trigger with no picker still reads as an open autocomplete, which silently turns off history recall, agent
 * cycling and markdown auto-pairing. --- */
import { isDesktopShell } from '@/lib/desktop';

export const snippetsOffered = (): boolean => !isDesktopShell();
