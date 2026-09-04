/* --- GeoCode: apply a saved configuration to the embedded kernel without restarting it
 * (docs/DESKTOP.md §5.2).
 *
 * Upstream applies settings by restarting the CLI it spawned. Under Electron the shell does
 * not own the kernel and does not need to: `POST /global/dispose` makes the kernel drop
 * every instance and, in GeoCode's kernel, the global config layer as well, so the next
 * request rebuilds from the files the settings pages just wrote. Same wire shape as
 * lib/event-stream/global-hub.js: the shell's own URL builder and auth headers, no SDK. --- */

export const KERNEL_REFRESH_PATH = '/global/dispose';

export const refreshEmbeddedKernel = async ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(buildOpenCodeUrl(KERNEL_REFRESH_PATH, ''), {
      method: 'POST',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Kernel refresh failed: HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};
