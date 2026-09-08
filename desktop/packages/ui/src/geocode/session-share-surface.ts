/* --- GeoCode: session sharing is not a surface GeoCode offers (docs/DESKTOP.md §7.3).
 *
 * The kernel refuses first, and unconditionally: share/share-next.ts gates every entry point of the
 * module on OPENCODE_DISABLE_SHARE, which defaults to disabled, and config/geocode.ts ships
 * `share: "disabled"` on top of that. A share uploads the whole session to https://opncd.ai, an
 * upstream service: every message, every tool call and its result, the session diff and the working
 * directory, and it keeps syncing while the session runs. A GeoCode session can carry unpublished
 * research data.
 *
 * The menus went on offering it, and the failure was silent: the SDK assertion throws before the
 * error toast is reached, and the click handlers are floating promises, so the entry did nothing at
 * all. This constant closes the entrances. It does not read the runtime, because the kernel's gate
 * does not either: sharing is equally dead under Electron and under a plain web build. --- */

export const SESSION_SHARING_OFFERED: boolean = false;
