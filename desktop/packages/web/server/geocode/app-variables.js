// The kernel's, the shell's and the runtimes' own settings, which the app does not take from the user's environment.
// Prefixes, not names, so variables upstream adds later are dropped too.
const APP_VARIABLE_PREFIXES = Object.freeze(['OPENCODE_', 'OPENCHAMBER_', 'OTEL_', 'BUN_', 'ELECTRON_']);

export const isAppVariable = (key) => APP_VARIABLE_PREFIXES.some((prefix) => key.startsWith(prefix));

export const withoutAppVariables = (environment) =>
  Object.fromEntries(Object.entries(environment).filter(([key]) => !isAppVariable(key)));

// The directories the main process gives the shell (`useGeoCodeDataDir`), for the shell alone: an OpenChamber the
// user installed, run in a terminal or by the agent, would take them for its own.
export const dropShellDirectories = (environment) => {
  delete environment.OPENCHAMBER_DATA_DIR;
  delete environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
};
