/* --- GeoCode: the desktop shell has no host switcher (docs/DESKTOP.md §7.3), so the shortcut that
 * toggles it does nothing there and is not listed. --- */

const HIDDEN_DESKTOP_SHORTCUT_IDS: ReadonlySet<string> = new Set(['toggle_services_menu']);

export const isShortcutHiddenOnDesktop = (id: string | undefined, desktopShell: boolean): boolean =>
  desktopShell && id !== undefined && HIDDEN_DESKTOP_SHORTCUT_IDS.has(id);
