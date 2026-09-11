/* --- GeoCode: what the window is told when the kernel does not come up (docs/DESKTOP.md §5.1).
 *
 * The shell has one host, this machine, so a boot has two outcomes: the kernel is up, or it is
 * not. Upstream's answer to the second was a recovery screen about installing OpenCode or
 * connecting elsewhere; GeoCode's is a failure screen, and this is the record it renders. It
 * carries the error, the last lines the kernel wrote before it died, and where the full log
 * is, so the user can read or send it. --- */

export const KERNEL_OUTPUT_TAIL_LINES = 40;

// The kernel's last `limit` output chunks, each maybe several lines; read only if the start fails.
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

export const describeKernelFailure = ({ error, logPath, at = new Date() }) => ({
  message: error instanceof Error ? error.message : String(error ?? 'unknown error'),
  output: Array.isArray(error?.kernelOutput) ? [...error.kernelOutput] : [],
  logPath: typeof logPath === 'string' && logPath ? logPath : null,
  at: at.toISOString(),
});
