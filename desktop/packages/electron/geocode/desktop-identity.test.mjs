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

  it('refuses our own schemes in the chat link classifier, and no longer the upstream pair', () => {
    // Upstream keeps its own schemes off the app-link path so chat content cannot re-launch the
    // product's internal deep links; the classifier is in the renderer, which cannot import this
    // module, so it hand-copies the two names. Renaming one side alone silently turns
    // `geocode://` into an ordinary third-party app link, and its "trust" option then opens
    // every later one without asking.
    const url = fs.readFileSync(
      path.resolve(electronRoot, '../ui/src/lib/url.ts'),
      'utf8',
    );
    const blocked = url.match(/const BLOCKED_APP_LINK_SCHEMES = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
    expect(blocked).toContain(`'${DesktopIdentity.deepLinkProtocol}'`);
    expect(blocked).toContain(`'${DesktopIdentity.uiProtocol}'`);
    expect(blocked).not.toContain("'openchamber'");
    expect(blocked).not.toContain("'openchamber-ui'");
  });

  it('sends the OAuth return leg to our own protocol', () => {
    // The MCP authorization return lands in the system browser, which raises the app by opening a
    // deep link. Two pages carry it — the in-app route and the self-contained one the server
    // renders for a browser with no UI session — and neither can import this module.
    const focus = `${DesktopIdentity.deepLinkProtocol}://focus/mcp-auth`;
    for (const file of ['../ui/src/components/sections/mcp/McpOAuthCallbackPage.tsx', '../web/server/lib/opencode/routes.js']) {
      const source = fs.readFileSync(path.resolve(electronRoot, file), 'utf8');
      expect([file, source.includes(focus)]).toEqual([file, true]);
      expect([file, source.includes('openchamber://focus')]).toEqual([file, false]);
    }
  });

  it('names the browser panel partition the renderer actually mounts', () => {
    // The renderer cannot import the identity either. main.mjs answers capture and clear-data only
    // for views in this partition, so a drift here breaks both while open and click still work.
    const pane = fs.readFileSync(
      path.resolve(electronRoot, '../ui/src/components/browser/BrowserPane.tsx'),
      'utf8',
    );
    expect(pane.match(/const BROWSER_PARTITION = '([^']+)'/)?.[1]).toBe(DesktopIdentity.browserPanelPartition);
    expect(pane).not.toContain("'persist:openchamber-browser'");
    expect(pane).not.toContain('partition="persist:');
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
