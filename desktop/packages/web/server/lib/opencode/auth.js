import fs from 'fs';
import path from 'path';
import os from 'os';
import { kernelDataRoot } from '../../geocode/kernel-roots.js'; // GeoCode: see the block below
import { CONFIG_BACKUP_SUFFIX } from '../../geocode/config-backup.js'; // GeoCode: own module

// --- GeoCode: the kernel's own data root, not the user's OpenCode installation
// (geocode/kernel-roots.js). Every quota provider and the small-model client reach auth.json
// through this module, so this one line is the whole fix: the app stops reading real OpenCode
// credentials, and `writeAuthFile` below stops leaving a copy of them beside OpenCode's own. ---
const OPENCODE_DATA_DIR = kernelDataRoot();
// --- /GeoCode ---
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

function readAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed);
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
}

function writeAuthFile(auth) {
  try {
    if (!fs.existsSync(OPENCODE_DATA_DIR)) {
      fs.mkdirSync(OPENCODE_DATA_DIR, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== 'win32') fs.chmodSync(OPENCODE_DATA_DIR, 0o700);

    if (fs.existsSync(AUTH_FILE)) {
      const backupFile = `${AUTH_FILE}${CONFIG_BACKUP_SUFFIX}`;
      fs.copyFileSync(AUTH_FILE, backupFile);
      if (process.platform !== 'win32') fs.chmodSync(backupFile, 0o600);
      console.log(`Created auth backup: ${backupFile}`);
    }

    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(AUTH_FILE, 0o600);
    console.log('Successfully wrote auth file');
  } catch (error) {
    console.error('Failed to write auth file:', error);
    throw new Error('Failed to write OpenCode auth configuration');
  }
}

function removeProviderAuth(providerId) {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const auth = readAuthFile();
  
  if (!auth[providerId]) {
    console.log(`Provider ${providerId} not found in auth file, nothing to remove`);
    return false;
  }

  delete auth[providerId];
  writeAuthFile(auth);
  console.log(`Removed provider auth: ${providerId}`);
  return true;
}

function getProviderAuth(providerId) {
  const auth = readAuthFile();
  return auth[providerId] || null;
}

function listProviderAuths() {
  const auth = readAuthFile();
  return Object.keys(auth);
}

export {
  readAuthFile,
  writeAuthFile,
  removeProviderAuth,
  getProviderAuth,
  listProviderAuths,
  AUTH_FILE,
  OPENCODE_DATA_DIR
};
