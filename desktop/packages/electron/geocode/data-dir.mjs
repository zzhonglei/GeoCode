import path from 'node:path';
import { kernelDataDir } from '@openchamber/web/server/geocode/kernel-paths.js';

// The shell keeps its data under the kernel's data directory, not in OpenChamber's ~/.config/openchamber.
// Set before the first read: the splash reads settings.json, and main.mjs fixes some paths when it loads.
export const useGeoCodeDataDir = (environment) => {
  environment.OPENCHAMBER_DATA_DIR = path.join(kernelDataDir(), 'desktop');
  environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(environment.OPENCHAMBER_DATA_DIR, 'managed-kernel');
};
