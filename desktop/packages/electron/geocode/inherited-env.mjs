import { app } from 'electron';

// Prefixes, not names, so variables upstream adds later are dropped too.
const APP_VARIABLE_PREFIXES = Object.freeze(['OPENCODE_', 'OPENCHAMBER_', 'OTEL_', 'BUN_', 'ELECTRON_']);

const isAppVariable = (key) => APP_VARIABLE_PREFIXES.some((prefix) => key.startsWith(prefix));

// Development launches pass their settings through these variables.
export const dropInheritedAppVariables = (environment) => {
  if (!app.isPackaged || !environment) return;
  for (const key of Object.keys(environment)) {
    if (isAppVariable(key)) delete environment[key];
  }
};

// The user's environment for processes that are not the kernel or the shell, such as GeoEngine and its tasks.
export const withoutAppVariables = (environment) =>
  Object.fromEntries(Object.entries(environment).filter(([key]) => !isAppVariable(key)));
