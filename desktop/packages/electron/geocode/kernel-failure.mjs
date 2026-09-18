/* --- GeoCode: the record the failure screen renders when the kernel does not come up or exits later
 * (docs/DESKTOP.md §5.1). --- */

export const KERNEL_OUTPUT_TAIL_LINES = 40;

/** Announces a kernel that went away after ready. The renderer keeps a copy, pinned by kernel-failure.test.mjs. */
export const KERNEL_LOST_EVENT = 'geocode:kernel-lost';

// Holds the last `limit` output chunks, each of which may span several lines.
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
