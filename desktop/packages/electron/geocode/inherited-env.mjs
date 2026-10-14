import { app } from 'electron';
import { isAppVariable } from '@openchamber/web/server/geocode/app-variables.js';

// Development launches pass their settings through these variables.
export const dropInheritedAppVariables = (environment) => {
  if (!app.isPackaged || !environment) return;
  for (const key of Object.keys(environment)) {
    if (isAppVariable(key)) delete environment[key];
  }
};
