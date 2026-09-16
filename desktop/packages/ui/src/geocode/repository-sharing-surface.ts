/* --- GeoCode: moving a project setup into the checkout is not a surface GeoCode offers
 * (docs/DESKTOP.md §7.3).
 *
 * The server refuses first, and on both legs: `readSharedProjectConfig` reports the file missing
 * whatever it holds, and the write route answers 404 ahead of upstream's handler. What a shared
 * setup carries is worktree setup commands that run on checkout and project actions bound to
 * sidebar buttons — shell commands written by whoever committed the file. GeoCode's users work
 * alone, and often inside repositories they did not write.
 *
 * The entrances stayed open, and they promise something that cannot happen: the tooltip reads
 * "everyone who pulls the repository gets it", the click reaches the refused route, and the user
 * gets a failure toast for an action the product does not have. One entrance did not even fail
 * out loud — the draft starter chip swallows the null return. This constant closes all three, and
 * the move button on each plan in the plans list, which the server refuses for want of a shared folder.
 *
 * It does not read the runtime, because the server's refusal does not either: the surface is
 * equally absent under Electron and under a plain web build. --- */

export const REPOSITORY_SHARING_OFFERED: boolean = false;
