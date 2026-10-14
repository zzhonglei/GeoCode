// The kernel's, the shell's and the runtimes' own settings, which the app does not take from the user's environment.
// Prefixes, not names, so variables upstream adds later are dropped too.
const APP_VARIABLE_PREFIXES = Object.freeze(['OPENCODE_', 'OPENCHAMBER_', 'OTEL_', 'BUN_', 'ELECTRON_']);

export const isAppVariable = (key) => APP_VARIABLE_PREFIXES.some((prefix) => key.startsWith(prefix));

export const withoutAppVariables = (environment) =>
  Object.fromEntries(Object.entries(environment).filter(([key]) => !isAppVariable(key)));
