import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DesktopIdentity } from './desktop-identity.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readElectronFile = (name) => fs.readFileSync(path.join(electronRoot, name), 'utf8');

describe('desktop identity', () => {
  it('is the origin the shell runtime trusts for the bundled UI', () => {
    // A hand-copy in the web package; drifted, requests from the window get no CORS headers and the UI reports the
    // server unreachable.
    const source = fs.readFileSync(
      path.resolve(electronRoot, '../web/server/geocode/shell-identity.js'),
      'utf8',
    );
    const copied = source.match(/export const PACKAGED_UI_ORIGIN = '([^']+)'/)?.[1];
    expect(copied).toBe(`${DesktopIdentity.uiProtocol}://app`);
  });

  it('keeps package.json build fields from drifting, since JSON carries no patch marker', () => {
    // An upstream merge can revert these without leaving a trace (docs/CONVENTIONS.md §5).
    const { build } = JSON.parse(readElectronFile('package.json'));
    expect(build.appId).toBe(DesktopIdentity.appId);
    expect(build.productName).toBe(DesktopIdentity.productName);
    expect(build.linux.executableName).toBe(DesktopIdentity.executableName);
    expect(build.linux.desktop.entry.Name).toBe(DesktopIdentity.productName);
  });

  it('ships the product name in the metadata that travels with the installer', () => {
    // `name` stays upstream's, which main.mjs and upstream scripts look the package up by; Windows gets its rewrite
    // from extraMetadata.
    const manifest = JSON.parse(readElectronFile('package.json'));
    expect(manifest.author).toBe(DesktopIdentity.productName);
    expect(manifest.description).toContain(DesktopIdentity.productName);
    expect(manifest.name).toBe('@openchamber/electron');
  });

  it('publishes to, and announces from, the release repository it names', () => {
    // package.json and the renderer cannot import the identity, so each carries a copy.
    const { build } = JSON.parse(readElectronFile('package.json'));
    expect(`${build.publish.owner}/${build.publish.repo}`).toBe(DesktopIdentity.releaseRepository);
    expect(DesktopIdentity.releasesUrl).toBe(`https://github.com/${DesktopIdentity.releaseRepository}/releases`);
    const dialog = fs.readFileSync(
      path.resolve(electronRoot, '../ui/src/components/ui/UpdateDialog.tsx'),
      'utf8',
    );
    const copied = dialog.match(/const GITHUB_RELEASES_URL = '([^']+)'/)?.[1];
    expect(copied).toBe(DesktopIdentity.releasesUrl);
    const about = fs.readFileSync(path.resolve(electronRoot, '../ui/src/geocode/GeoCodeAboutDialog.tsx'), 'utf8');
    expect(about.match(/const GEOCODE_REPOSITORY_URL = '([^']+)'/)?.[1])
      .toBe(`https://github.com/${DesktopIdentity.releaseRepository}`);
  });

  it('names the directories the kernel brands', () => {
    // A copy of `core/src/brand.ts`, which this package cannot import. The credential guard builds
    // the path of the kernel's auth.json from it, so a drift leaves that file readable.
    const brand = fs.readFileSync(path.resolve(electronRoot, '../../../kernel/packages/core/src/brand.ts'), 'utf8');
    expect(DesktopIdentity.dirName).toBe(brand.match(/const dirName = "([^"]+)"/)?.[1]);
    expect(DesktopIdentity.name).toBe(brand.match(/const name = "([^"]+)"/)?.[1]);
  });

  it('rewrites the Windows install directory, which comes from name and not productName', () => {
    // Without it the install directory follows upstream's package name, and a wrong one persists in the registry's
    // InstallLocation (docs/PATHS.md §3.5).
    const { build } = JSON.parse(readElectronFile('package.json'));
    expect(build.extraMetadata?.name).toBe(DesktopIdentity.windowsPackageName);
  });

  it('refuses our own schemes in the chat link classifier', () => {
    // The renderer hand-copies these; a drift turns `geocode://` in chat content into a third-party app link whose
    // "trust" option then opens every later one without asking.
    const url = fs.readFileSync(
      path.resolve(electronRoot, '../ui/src/lib/url.ts'),
      'utf8',
    );
    const blocked = url.match(/const BLOCKED_APP_LINK_SCHEMES = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
    expect(blocked).toContain(`'${DesktopIdentity.deepLinkProtocol}'`);
    expect(blocked).toContain(`'${DesktopIdentity.uiProtocol}'`);
  });

  it('sends the OAuth return leg to our own protocol', () => {
    // Both pages that raise the app from the browser after MCP authorization hand-copy the scheme.
    const focus = `${DesktopIdentity.deepLinkProtocol}://focus/mcp-auth`;
    for (const file of ['../ui/src/components/sections/mcp/McpOAuthCallbackPage.tsx', '../web/server/lib/opencode/routes.js']) {
      // Line comments are dropped first: upstream's own comment in routes.js still names its protocol.
      const source = fs.readFileSync(path.resolve(electronRoot, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      expect([file, source.includes(focus)]).toEqual([file, true]);
      expect([file, source.includes('openchamber://focus')]).toEqual([file, false]);
    }
  });

  it('names the browser panel partition the renderer actually mounts', () => {
    // main.mjs answers capture and clear-data only for views in this partition, so a drift breaks both while open
    // and click still work.
    const pane = fs.readFileSync(
      path.resolve(electronRoot, '../ui/src/components/browser/BrowserPane.tsx'),
      'utf8',
    );
    expect(pane.match(/const BROWSER_PARTITION = '([^']+)'/)?.[1]).toBe(DesktopIdentity.browserPanelPartition);
    expect(pane).not.toContain("'persist:openchamber-browser'");
    expect(pane).not.toContain('partition="persist:');
  });

  it('reads the bundled UI origin from the shell instead of naming it', () => {
    // preload ships unbundled and cannot import the identity, so every window that opens with it has to pass the
    // origin, or that window loses what the check gates.
    const preload = readElectronFile('preload.mjs');
    expect(preload).toContain("readArgValue('--openchamber-packaged-origin')");
    // The declaration alone is not the comparison: the gate has to be the thing that reads it.
    expect(preload).toMatch(/isLocalPage =[\s\S]*?currentOrigin === packagedOrigin/);
    const main = readElectronFile('main.mjs');
    const windows = main.split('additionalArguments:').length - 1;
    const passes = main.split('`--openchamber-packaged-origin=${packagedUiOrigin()}`').length - 1;
    expect(windows).toBeGreaterThan(0);
    expect(passes).toBe(windows);
  });

  it('names our scheme where the renderer decides the window is the local instance', () => {
    // A renderer hand-copy behind earlier checks that can answer first, so a drift stays invisible.
    const host = fs.readFileSync(
      path.resolve(electronRoot, '../ui/src/lib/desktopCurrentHost.ts'),
      'utf8',
    );
    expect(host.match(/const PACKAGED_UI_SCHEME = '([^']+)'/)?.[1]).toBe(`${DesktopIdentity.uiProtocol}://`);
    expect(host).not.toContain('openchamber-ui');
  });

  it('names the log directory the diagnostics report sends the user to', () => {
    // electron-log names the directory after the product, and this report is where a user learns where to look.
    const status = fs.readFileSync(
      path.resolve(electronRoot, '../ui/src/lib/openCodeStatus.ts'),
      'utf8',
    );
    expect(status.match(/const DESKTOP_DIR_NAME = '([^']+)'/)?.[1]).toBe(DesktopIdentity.dirName);
    expect(status).toContain('Logs/${DESKTOP_DIR_NAME}/main.log');
    expect(status).not.toContain('Logs/OpenChamber');
    expect(status).not.toContain('OpenChamber\\\\logs');
    // The line is gated on being the desktop shell; upstream's scheme never matches GeoCode's window.
    expect(status).not.toContain('openchamber-ui');
  });

  it('sends Help feedback to the repository it names, and offers no Discord', () => {
    expect(DesktopIdentity.newIssueUrl).toBe(`https://github.com/${DesktopIdentity.releaseRepository}/issues/new`);
    const main = readElectronFile('main.mjs');
    const lines = main.split('\n');
    // Inside a GeoCode shield: the nearest whole `/*` line above comes after the nearest whole `*/` line.
    const shielded = (at) => {
      const above = lines.slice(0, at).map((line) => line.trim());
      return above.lastIndexOf('/*') > above.lastIndexOf('*/');
    };
    const menus = lines.flatMap((line, at) => (/^\s*label: 'Help',$/.test(line) ? [at] : []));
    expect(menus.length).toBe(2);
    for (const start of menus) {
      const end = lines.findIndex((line, at) => at > start && /^\s*\],$/.test(line));
      const live = lines.slice(start, end).map((line, offset) => [line, start + offset]).filter(([, at]) => !shielded(at));
      const opened = live.flatMap(([line]) => [...line.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map((match) => match[1]));
      expect(opened).toEqual(['GITHUB_BUG_REPORT_URL', 'GITHUB_FEATURE_REQUEST_URL']);
      expect(live.some(([line]) => line.includes("label: 'Join Discord'"))).toBe(false);
    }
    for (const name of ['GITHUB_BUG_REPORT_URL', 'GITHUB_FEATURE_REQUEST_URL']) {
      expect([name, main.match(new RegExp(`^const ${name} = ([^;\\n]+);`, 'm'))?.[1]])
        .toEqual([name, 'DesktopIdentity.newIssueUrl']);
    }
  });

  it('leaves no upstream identity literal in the files the installer ships', () => {
    // Guards a merge that quietly restores one. Files come from build.files, so a newly shipped file is scanned too;
    // wire names are absent on purpose (desktop-identity.mjs).
    const { build } = JSON.parse(readElectronFile('package.json'));
    // `dist-bundle/main.mjs` is built from `main.mjs`; the source is what a merge touches.
    const shipped = build.files.map((entry) => entry.replace(/^dist-bundle\//, ''));
    expect(shipped.length).toBeGreaterThan(1);
    for (const file of shipped) {
      const source = readElectronFile(file);
      for (const literal of [
        "app.setName('OpenChamber')",
        // No closing quote: upstream spells the dev build `dev.openchamber.desktop.dev`.
        "'dev.openchamber.desktop",
        'openchamber-ui',
        "'persist:openchamber-browser'",
        "'openchamber.desktop'",
        "'OpenChamber Dev'",
      ]) {
        expect([file, literal, source.includes(literal)]).toEqual([file, literal, false]);
      }
    }
  });

  it('takes the deep-link protocol from the identity', () => {
    // Upstream's value would ask to handle OpenChamber's links and ignore GeoCode's own.
    const main = readElectronFile('main.mjs').replace(/^\s*\/\/.*$/gm, '');
    expect(main).toContain('const DEEP_LINK_PROTOCOL = DesktopIdentity.deepLinkProtocol;');
  });
});
