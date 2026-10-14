import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTEXT_MENU_LABEL_DICTIONARIES, MENU_LOCALE_DICTIONARIES } from '../../../electron/menu-locales.mjs';
import { menuLabel } from '../../../electron/geocode/menu-labels.mjs';

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
      "title: 'Connect to OpenChamber server?',",
      "throw new Error('Desktop update requires OpenChamber.app to be installed in /Applications');",
    ]);
  });

  it('names GeoCode in the tray and the window titles', () => {
    expect(naming('electron/tray.mjs')).toEqual([]);
    // The splash keeps upstream's cube, label included, inside a template that is never drawn.
    expect(naming('electron/early-startup.mjs')).toEqual([
      '<svg width="120" height="120" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="OpenChamber loading icon">',
    ]);
  });

  it('names GeoCode in the menus in every language', () => {
    const labels = Object.entries(MENU_LOCALE_DICTIONARIES)
      .flatMap(([locale, dictionary]) => Object.keys(dictionary).map((key) => menuLabel(locale, key)));
    expect(labels.filter((label) => label.includes('OpenChamber'))).toEqual([]);
    // Role items and the context menu read upstream's dictionaries unwrapped, so only the keys menuLabel serves may name it.
    const named = [MENU_LOCALE_DICTIONARIES, CONTEXT_MENU_LABEL_DICTIONARIES]
      .flatMap((dictionaries) => Object.values(dictionaries))
      .flatMap((dictionary) => Object.entries(dictionary))
      .filter(([, label]) => label.includes('OpenChamber'))
      .map(([key]) => key);
    expect([...new Set(named)].sort()).toEqual(['about', 'app.name']);
  });
});
