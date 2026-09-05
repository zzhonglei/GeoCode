import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DesktopIdentity } from './desktop-identity.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readElectronFile = (name) => fs.readFileSync(path.join(electronRoot, name), 'utf8');

describe('desktop identity', () => {
  it('is the origin the shell runtime trusts for the bundled UI', () => {
    // A hand-copy in the web package (CONVENTIONS.md §3 forbids the import). The two drift
    // with no conflict and no failure, except that every request from the window then gets
    // no CORS headers and the UI reports the server unreachable.
    const source = fs.readFileSync(
      path.resolve(electronRoot, '../web/server/geocode/shell-identity.js'),
      'utf8',
    );
    const copied = source.match(/export const PACKAGED_UI_ORIGIN = '([^']+)'/)?.[1];
    expect(copied).toBe(`${DesktopIdentity.uiProtocol}://app`);
  });

  it('derives every field from the two base strings', () => {
    // A field written flat still passes typecheck and still looks right today; it only
    // diverges the next time a base string changes, silently. Same reason `Brand` on the
    // kernel side enumerates its fields.
    for (const [key, value] of Object.entries(DesktopIdentity)) {
      expect(typeof value).toBe('string');
      expect(`${key}=${value}`).toMatch(/GeoCode|geocode/);
    }
  });

  it('keeps package.json build fields from drifting, since JSON carries no patch marker', () => {
    // CONVENTIONS.md §5: JSON is one of the two file kinds the locator grep cannot see, so
    // an upstream merge can revert these without leaving a trace anywhere else.
    const { build } = JSON.parse(readElectronFile('package.json'));
    expect(build.appId).toBe(DesktopIdentity.appId);
    expect(build.productName).toBe(DesktopIdentity.productName);
    expect(build.linux.executableName).toBe(DesktopIdentity.executableName);
    expect(build.linux.desktop.entry.Name).toBe(DesktopIdentity.productName);
  });

  it('ships the product name in the metadata that travels with the installer', () => {
    // `author` reaches the installed package's metadata, so it is the product's name and not
    // upstream's. `name` stays `@openchamber/electron`: other workspace packages import it,
    // and Windows gets the rewrite it needs from extraMetadata instead.
    const manifest = JSON.parse(readElectronFile('package.json'));
    expect(manifest.author).toBe(DesktopIdentity.productName);
    expect(manifest.description).toContain(DesktopIdentity.productName);
    expect(manifest.name).toBe('@openchamber/electron');
  });

  it('publishes to, and announces from, the release repository it names', () => {
    // package.json cannot import the identity; the renderer cannot import the electron package.
    // Both carry a copy, and each copy is pinned here so neither can drift back to upstream's.
    const { build } = JSON.parse(readElectronFile('package.json'));
    expect(`${build.publish.owner}/${build.publish.repo}`).toBe(DesktopIdentity.releaseRepository);
    expect(DesktopIdentity.releasesUrl).toBe(`https://github.com/${DesktopIdentity.releaseRepository}/releases`);
    const dialog = fs.readFileSync(
      path.resolve(electronRoot, '../ui/src/components/ui/UpdateDialog.tsx'),
      'utf8',
    );
    const copied = dialog.match(/const GITHUB_RELEASES_URL = '([^']+)'/)?.[1];
    expect(copied).toBe(DesktopIdentity.releasesUrl);
  });

  it('rewrites the Windows install directory, which comes from name and not productName', () => {
    // PATHS.md §2: without this, GeoCode installs over upstream OpenCode, and the wrong path
    // then sticks in the registry's InstallLocation where reinstalling does not clear it.
    const { build } = JSON.parse(readElectronFile('package.json'));
    expect(build.extraMetadata?.name).toBe(DesktopIdentity.windowsPackageName);
  });

  it('leaves no upstream identity literal in main.mjs', () => {
    // Guards the merge that quietly restores one. Wire fingerprints are deliberately absent
    // from this list: OPENCHAMBER_* variables, the @openchamber/electron package name and
    // the openchamber: IPC channels identify the code, not the product, and stay upstream.
    const main = readElectronFile('main.mjs');
    for (const literal of [
      "app.setName('OpenChamber')",
      "'dev.openchamber.desktop'",
      "'openchamber-ui'",
      "'persist:openchamber-browser'",
      "'openchamber.desktop'",
      "'OpenChamber Dev'",
    ]) {
      expect(main).not.toContain(literal);
    }
  });
});
