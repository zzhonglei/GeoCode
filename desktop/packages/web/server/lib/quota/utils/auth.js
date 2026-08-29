import fs from 'fs';
import path from 'path';
import os from 'os';
import { kernelConfigRoot, kernelDataRoot } from '../../../geocode/kernel-roots.js'; // GeoCode: see the block below

// --- GeoCode: the kernel's own roots, not the user's OpenCode installation
// (geocode/kernel-roots.js). They feed the antigravity account paths below, which are read
// whenever the quota panel enumerates providers — so before this, opening that panel read two
// files out of a separate product's directories. ---
const OPENCODE_CONFIG_DIR = kernelConfigRoot();
const OPENCODE_DATA_DIR = kernelDataRoot();
// --- /GeoCode ---

export const ANTIGRAVITY_ACCOUNTS_PATHS = [
  path.join(OPENCODE_CONFIG_DIR, 'antigravity-accounts.json'),
  path.join(OPENCODE_DATA_DIR, 'antigravity-accounts.json')
];

export const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (error) {
    console.warn(`Failed to read JSON file: ${filePath}`, error);
    return null;
  }
};

export const getAuthEntry = (auth, aliases) => {
  for (const alias of aliases) {
    if (auth[alias]) {
      return auth[alias];
    }
  }
  return null;
};

export const normalizeAuthEntry = (entry) => {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { token: entry };
  }
  if (typeof entry === 'object') {
    return entry;
  }
  return null;
};
