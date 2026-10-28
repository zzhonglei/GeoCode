// The kernel's, the shell's and the runtimes' own settings, which the app does not take from the user's environment.
// Prefixes, not names, so variables upstream adds later are dropped too.
const APP_VARIABLE_PREFIXES = Object.freeze(['OPENCODE_', 'OPENCHAMBER_', 'OTEL_', 'BUN_', 'ELECTRON_']);

// Windows reads variable names in any case, so `Opencode_Binary` is still `OPENCODE_BINARY` there.
export const isAppVariable = (key) => {
  const name = process.platform === 'win32' ? key.toUpperCase() : key;
  return APP_VARIABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
};

export const withoutAppVariables = (environment) =>
  Object.fromEntries(Object.entries(environment).filter(([key]) => !isAppVariable(key)));

// The home and temporary directories. Set in Settings they would move the kernel's and GeoEngine's files, while the
// shell, which takes nothing from Settings, keeps its own where they were.
const SETTINGS_DIRECTORY_VARIABLES = Object.freeze(['HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP']);

export const withoutDirectoryVariables = (environment) =>
  Object.fromEntries(Object.entries(environment).filter(([key]) => (
    !SETTINGS_DIRECTORY_VARIABLES.includes(process.platform === 'win32' ? key.toUpperCase() : key)
  )));

// The directories the main process gives the shell (`useGeoCodeDataDir`), for the shell alone: an OpenChamber the
// user installed, run in a terminal or by the agent, would take them for its own.
export const dropShellDirectories = (environment) => {
  delete environment.OPENCHAMBER_DATA_DIR;
  delete environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
};
