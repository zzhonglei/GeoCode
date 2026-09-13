/* --- GeoCode: what the window is told when the kernel does not come up, or goes away later
 * (docs/DESKTOP.md §5.1, §5.2).
 *
 * The shell has one host, this machine, so a boot has two outcomes: the kernel is up, or it is
 * not. Upstream's answer to the second was a recovery screen about installing OpenCode or
 * connecting elsewhere; GeoCode's is a failure screen, and this is the record it renders. It
 * carries the error, the last lines the kernel wrote before it died, and where the full log
 * is, so the user can read or send it. A kernel that dies after ready gets the same record and
 * the same screen. --- */

export const KERNEL_OUTPUT_TAIL_LINES = 40;

/** Announces a kernel that went away after ready. The renderer keeps a copy, pinned by kernel-failure.test.mjs. */
export const KERNEL_LOST_EVENT = 'geocode:kernel-lost';

// The kernel's last `limit` output chunks, each maybe several lines; read only if the kernel fails.
export const createOutputTail = (limit = KERNEL_OUTPUT_TAIL_LINES) => {
  const lines = [];
  return {
    push: (line) => {
      lines.push(String(line));
      if (lines.length > limit) lines.splice(0, lines.length - limit);
    },
    lines: () => [...lines],
  };
};

export const describeKernelFailure = ({ error, logPath, phase = 'start', at = new Date() }) => ({
  phase,
  message: error instanceof Error ? error.message : String(error ?? 'unknown error'),
  output: Array.isArray(error?.kernelOutput) ? [...error.kernelOutput] : [],
  logPath: typeof logPath === 'string' && logPath ? logPath : null,
  at: at.toISOString(),
});

// `isCurrent` is what tells a crash from a quit: quitting drops the handle before the exit arrives.
export const watchKernelExit = ({ handle, isCurrent, logPath, onLost }) =>
  handle.exit.then((code) => {
    if (!isCurrent()) return;
    const error = Object.assign(new Error(`GeoCode Kernel exited while running, with code ${code}`), {
      kernelOutput: handle.outputTail?.() ?? [],
    });
    onLost(describeKernelFailure({ error, logPath: logPath(), phase: 'running' }));
  });
