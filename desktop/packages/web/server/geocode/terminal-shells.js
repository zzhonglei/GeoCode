import { getTerminalShellLoginArgs } from '../lib/terminal/shells.js';

// The terminal's shells on Windows. The others found there are left out, bash above all: there it is usually WSL's
// launcher in System32, which opens a Linux where the project's paths, the app's variables and the geo software are
// not what they are on Windows.
const WINDOWS_SHELLS = Object.freeze(['cmd', 'powershell', 'pwsh']);

// Wraps the terminal's shell resolver, which both lists the shells and picks the one a terminal starts, so a shell
// left out is neither offered nor run: any choice but a kept one runs as auto does, among the shells kept.
export const withWindowsShells = (resolver, platform = process.platform) => {
  if (platform !== 'win32') return resolver;
  const kept = async () => (await resolver.list()).filter((shell) => WINDOWS_SHELLS.includes(shell.id));
  const resolve = async (preference) => {
    const shells = await kept();
    const chosen = shells.find((shell) => shell.id === String(preference ?? '').trim().toLowerCase());
    if (chosen) return { id: chosen.id, executables: [chosen.executable] };
    const executables = new Set(shells.map((shell) => shell.executable.toLowerCase()));
    const auto = await resolver.resolve('auto');
    return { id: 'auto', executables: auto.executables.filter((executable) => executables.has(executable.toLowerCase())) };
  };
  const list = async () => {
    const [auto, shells] = await Promise.all([resolve('auto'), kept()]);
    const executable = auto.executables[0] ?? null;
    const supportsLogin = Boolean(executable && getTerminalShellLoginArgs(executable, platform));
    return [{ id: 'auto', name: 'Auto', executable, supportsLogin }, ...shells];
  };
  return { list, resolve };
};
