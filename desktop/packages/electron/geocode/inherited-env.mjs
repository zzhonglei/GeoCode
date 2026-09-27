import { app } from 'electron';

// Prefixes, not names, so variables upstream adds later are dropped too.
const APP_VARIABLE_PREFIXES = Object.freeze(['OPENCODE_', 'OPENCHAMBER_', 'OTEL_', 'BUN_', 'ELECTRON_']);

// Development launches pass their settings through these variables.
export const dropInheritedAppVariables = (environment) => {
  if (!app.isPackaged || !environment) return;
  for (const key of Object.keys(environment)) {
    if (APP_VARIABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) delete environment[key];
  }
};
