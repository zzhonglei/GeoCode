import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards against a merge bringing OpenChamber's name back into text the user sees. Each list holds
// the lines that may still name it, because the code around them is closed; a new line fails until judged.
const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const code = (relative) => fs.readFileSync(path.join(packages, relative), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '');

const naming = (relative) => code(relative).split('\n').map((line) => line.trim()).filter((line) => line.includes('OpenChamber'));

describe('GeoCode: visible names', () => {
  it('leaves OpenChamber only in the main process code that pairing, remote login and updates used', () => {
    expect(naming('electron/main.mjs')).toEqual([
      "clientLabel: 'OpenChamber Desktop',",
      "label: 'OpenChamber Desktop',",
      "label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : 'OpenChamber',",
      "clientLabel: 'OpenChamber Desktop',",
      "deviceName: 'OpenChamber Desktop',",
      "title: 'Connect to OpenChamber server?',",
      "throw new Error('Desktop update requires OpenChamber.app to be installed in /Applications');",
    ]);
  });

  it('names GeoCode in the tray and the window titles', () => {
    expect(naming('electron/tray.mjs')).toEqual([]);
    expect(naming('electron/early-startup.mjs')).toEqual([]);
  });
});
