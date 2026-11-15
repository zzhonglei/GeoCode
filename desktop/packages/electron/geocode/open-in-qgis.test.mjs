import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openInQgis, qgisProgram } from './open-in-qgis.mjs';

// Guards the Windows branch, which only Windows would run otherwise: a QGIS GeoEngine reports as `<root>\apps\<name>`
// opens by `<root>\bin\<name>-bin.exe`.
test('GeoCode: a Windows QGIS opens by the program its shortcuts start', () => {
  assert.equal(qgisProgram('C:\\Program Files\\QGIS 3.44.15\\apps\\qgis-ltr', 'win32'), 'C:\\Program Files\\QGIS 3.44.15\\bin\\qgis-ltr-bin.exe');
  assert.equal(qgisProgram('D:\\OSGeo4W\\apps\\qgis', 'win32'), 'D:\\OSGeo4W\\bin\\qgis-bin.exe');
});

// Guards against a QGIS that could not start being reported as opened.
test('GeoCode: opening in a QGIS that does not start fails', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-open-in-qgis-'));
  try {
    const file = path.join(folder, 'roads.gpkg');
    fs.writeFileSync(file, '');
    const ready = { status: 'ready', app: path.join(folder, 'apps', 'qgis') };
    await assert.rejects(openInQgis(file, ready, 'win32'), { code: 'ENOENT' });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
