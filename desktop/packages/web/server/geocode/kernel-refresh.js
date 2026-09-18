/* --- GeoCode: apply a saved configuration to the embedded kernel without restarting it: the dispose drops
 * every instance and, in GeoCode's kernel, the cached global config (docs/DESKTOP.md §5.2). --- */

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
