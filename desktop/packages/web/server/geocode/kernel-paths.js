import os from 'os';
import path from 'path';

// Where the bundled kernel keeps its files. Must match kernel/packages/util/src/global.ts
// and global-roots.ts: an empty XDG variable counts as unset there too.
const KERNEL_APP = 'geocode';
const root = (variable, ...fallback) => process.env[variable] || path.join(os.homedir(), ...fallback);

export const kernelConfigDir = () => path.join(root('XDG_CONFIG_HOME', '.config'), KERNEL_APP);
export const kernelDataDir = () => path.join(root('XDG_DATA_HOME', '.local', 'share'), KERNEL_APP);
export const kernelTmpDir = () => path.join(os.tmpdir(), KERNEL_APP);

// kernel/packages/core/src/config/discovery.ts
export const KERNEL_CONFIG_JSON = 'geocode.json';
export const KERNEL_CONFIG_JSONC = 'geocode.jsonc';
export const KERNEL_PROJECT_DIR = '.geocode';
// kernel/packages/cli/src/database-path.ts
export const KERNEL_DATABASE = 'geocode.db';
// kernel/packages/core/src/project.ts: the project id cached in the git directory
export const KERNEL_PROJECT_ID_FILE = 'geocode';
