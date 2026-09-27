import { app } from 'electron';

// Honoring these would point the app at another kernel, another host or a password the shell did not generate.
const IGNORED_USER_VARIABLES = Object.freeze([
  'OPENCODE_BINARY',
  'OPENCODE_PATH',
  'OPENCHAMBER_OPENCODE_PATH',
  'OPENCHAMBER_OPENCODE_BIN',
  'OPENCODE_HOST',
  'OPENCODE_PORT',
  'OPENCHAMBER_OPENCODE_PORT',
  'OPENCHAMBER_INTERNAL_PORT',
  'OPENCHAMBER_OPENCODE_HOSTNAME',
  'OPENCODE_SKIP_START',
  'OPENCHAMBER_SKIP_OPENCODE_START',
  'OPENCHAMBER_SKIP_LOCAL_SERVER',
  'OPENCHAMBER_SERVER_URL',
  'OPENCODE_PASSWORD',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
]);

// electron-dev.mjs sets this to the staged kernel; a packaged app uses only its own resources.
const DEVELOPMENT_ONLY_VARIABLES = Object.freeze(['OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR']);

export const dropIgnoredUserVariables = (...environments) => {
  const ignored = app.isPackaged ? [...IGNORED_USER_VARIABLES, ...DEVELOPMENT_ONLY_VARIABLES] : IGNORED_USER_VARIABLES;
  for (const environment of environments) {
    if (!environment) continue;
    for (const key of ignored) {
      delete environment[key];
    }
  }
};
