import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTerminalShellResolver } from '../lib/terminal/shells.js';
import { withWindowsShells } from './terminal-shells.js';

// A Windows with WSL, Git's Unix tools on PATH and PowerShell 7, the shell Git Bash sets as SHELL.
const WINDOWS_FILES = [
  'C:\\Windows\\system32\\cmd.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Windows\\system32\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
];
const WINDOWS_PATH = ['C:\\Windows\\system32', 'C:\\Program Files\\PowerShell\\7', 'C:\\Program Files\\Git\\usr\\bin'].join(';');

const windowsResolver = () => {
  const files = new Set(WINDOWS_FILES.map((file) => file.toLowerCase()));
  const isExecutable = (file) => files.has(String(file).toLowerCase());
  const searchPathFor = (name, searchPath) => {
    for (const dir of searchPath.split(';')) {
      for (const candidate of [`${name}.exe`, name]) {
        const file = path.win32.join(dir, candidate);
        if (isExecutable(file)) return file;
      }
    }
    return null;
  };
  return createTerminalShellResolver({
    fs: { promises: { readFile: async () => { throw new Error('no /etc/shells on Windows'); } } },
    path: path.win32,
    searchPathFor,
    isExecutable,
    buildAugmentedPath: () => WINDOWS_PATH,
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe', SystemRoot: 'C:\\Windows', SHELL: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', PATH: WINDOWS_PATH },
  });
};

// Guards against a Windows terminal offering or starting a shell other than cmd and PowerShell, such as WSL's bash.
describe('GeoCode: the terminal shells on Windows', () => {
  const resolver = withWindowsShells(windowsResolver(), 'win32');

  it('offers only auto, cmd and the two PowerShells', async () => {
    expect((await resolver.list()).map((shell) => shell.id)).toEqual(['auto', 'cmd', 'powershell', 'pwsh']);
  });

  it('starts auto, and a shell left out, with cmd or PowerShell only', async () => {
    for (const preference of ['auto', 'bash', 'sh']) {
      const { executables } = await resolver.resolve(preference);
      expect(executables.length).toBeGreaterThan(0);
      expect(executables.every((file) => /\\(cmd|powershell|pwsh)\.exe$/i.test(file))).toBe(true);
    }
    expect((await resolver.resolve('pwsh')).executables).toEqual(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']);
  });
});
