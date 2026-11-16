// This computer, which the app always reaches directly, as the kernel and the bundled Python do: a tile server the
// user runs here is no place for a proxy.
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/**
 * GeoEngine's environment with its own requests, for the online basemaps, sent as the rest of the app's are: through
 * the proxy HTTP_PROXY and HTTPS_PROXY name, which Node's fetch reads only under NODE_USE_ENV_PROXY, and to this
 * computer directly, which Node knows only from NO_PROXY. The user's own entries stay, under whichever spelling they
 * wrote.
 */
export const withEngineProxy = (environment) => {
  const names = Object.keys(environment).filter((key) => key.toUpperCase() === 'NO_PROXY');
  const listed = names.flatMap((key) => String(environment[key]).split(',')).map((entry) => entry.trim()).filter(Boolean);
  const bypass = [...new Set([...listed, ...LOOPBACK])].join(',');
  const spelled = names.length > 0 ? names : ['NO_PROXY'];
  return { ...environment, ...Object.fromEntries(spelled.map((key) => [key, bypass])), NODE_USE_ENV_PROXY: '1' };
};
