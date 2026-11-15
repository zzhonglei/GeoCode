import { spawn } from 'node:child_process';
import path from 'node:path';

import { validateLocalPath } from '../path-open-utils.mjs';

/**
 * The program that starts the QGIS GeoEngine reports as ready, from its `app`: the app bundle on macOS; on Windows
 * `<root>\apps\<name>`, whose shortcuts start `<root>\bin\<name>-bin.exe` (as PROGRAM in geoengine/src/qgis/windows.ts
 * recognises it).
 */
export const qgisProgram = (app, platform) => {
  if (platform !== 'win32') return app;
  const root = path.win32.dirname(path.win32.dirname(app));
  return path.win32.join(root, 'bin', `${path.win32.basename(app)}-bin.exe`);
};

/**
 * Opens a file in the QGIS set up in Settings. Which QGIS is read from GeoEngine's status here, so the window names
 * only the file. Settles once QGIS is started: on macOS when `open` has handed the file over, on Windows when the
 * program has started, as QGIS then runs on its own.
 */
export const openInQgis = async (filePath, qgis, platform = process.platform) => {
  const file = (await validateLocalPath(filePath, 'File path')).path;
  if (qgis?.status !== 'ready') throw new Error('QGIS is not ready');
  const [command, args] = platform === 'darwin' ? ['open', ['-a', qgis.app, file]] : [qgisProgram(qgis.app, platform), [file]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    if (platform !== 'darwin') {
      child.once('spawn', resolve);
      return;
    }
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`open exited with ${code}`))));
  });
  return null;
};
