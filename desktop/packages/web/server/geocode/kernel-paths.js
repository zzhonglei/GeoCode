import os from 'os';
import path from 'path';

// Where the bundled kernel keeps its files. Must match kernel/packages/util/src/global.ts
// and global-roots.ts: fixed under the home directory, whatever the XDG variables say.
const KERNEL_APP = 'geocode';

export const kernelConfigDir = () => path.join(os.homedir(), '.config', KERNEL_APP);
export const kernelDataDir = () => path.join(os.homedir(), '.local', 'share', KERNEL_APP);
export const kernelStateDir = () => path.join(os.homedir(), '.local', 'state', KERNEL_APP);
export const kernelTmpDir = () => path.join(os.tmpdir(), KERNEL_APP);

// The file name scripts/stage-kernel.sh gives the bundled kernel, which is the process name the system shows.
export const KERNEL_PROCESS = 'geocode-kernel';
export const KERNEL_BINARY = process.platform === 'win32' ? `${KERNEL_PROCESS}.exe` : KERNEL_PROCESS;

// kernel/packages/core/src/config/discovery.ts
export const KERNEL_CONFIG_JSON = 'geocode.json';
export const KERNEL_CONFIG_JSONC = 'geocode.jsonc';
export const KERNEL_PROJECT_DIR = '.geocode';
// kernel/packages/core/src/project.ts: the project id cached in the git directory
export const KERNEL_PROJECT_ID_FILE = 'geocode';
