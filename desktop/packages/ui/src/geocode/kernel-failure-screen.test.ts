/* --- GeoCode: the desktop shell shows its own screen when the kernel did not come up
 * (docs/DESKTOP.md §5.1).
 *
 * The swap in App.tsx is pinned by source: the GeoCode branch has to sit in front of the
 * upstream chooser and recovery routing, or those screens are reachable again with nothing
 * turning red. The screen itself is pinned for what it must not say and for the two main
 * process commands it depends on. --- */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (relative: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', relative), 'utf8');

describe('kernel failure screen', () => {
  test('App.tsx routes every non-main desktop boot view to it, ahead of the upstream screens', () => {
    const app = read('App.tsx');
    const guard = app.indexOf('<GeoCodeKernelFailureScreen onRetry={handleDesktopBootDismiss} />');
    const upstreamChooser = app.indexOf("if (bootView.screen === 'chooser') {");
    const upstreamRecovery = app.indexOf('mode="recovery"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(upstreamChooser);
    expect(guard).toBeLessThan(upstreamRecovery);
    // The branch condition is the same one upstream uses, so nothing slips past it.
    const branch = app.lastIndexOf("if (isDesktopRuntime && bootView && bootView.screen !== 'main') {", guard);
    expect(branch).toBeGreaterThan(-1);
    expect(app.slice(branch, guard)).not.toContain('OnboardingScreen');
  });

  test('the screen names GeoCode, reads the record, and offers no other server', () => {
    const screen = read('geocode/GeoCodeKernelFailureScreen.tsx');
    expect(screen).toContain("invokeDesktop<KernelFailure | null>('geocode_kernel_failure')");
    expect(screen).toContain("invokeDesktop('desktop_reveal_path', { path: failure.logPath })");
    const strings = screen.slice(screen.indexOf('const STRINGS'), screen.indexOf('const stringsFor'));
    for (const forbidden of ['opencode.ai', 'OpenChamber', 'OpenCode', 'curl', 'remote', '远程', '遠端', 'install', '安装', '安裝']) {
      expect(strings.includes(forbidden)).toBe(false);
    }
  });

  test('every product language has the same set of strings', () => {
    const screen = read('geocode/GeoCodeKernelFailureScreen.tsx');
    const blocks = [...screen.matchAll(/^  (?:en|'zh-CN'|'zh-TW'): \{\n([\s\S]*?)\n  \},/gm)].map((m) => m[1]);
    expect(blocks).toHaveLength(3);
    const keysOf = (block: string) => [...block.matchAll(/^\s+([a-zA-Z]+): '/gm)].map((m) => m[1]).sort();
    expect(keysOf(blocks[1])).toEqual(keysOf(blocks[0]));
    expect(keysOf(blocks[2])).toEqual(keysOf(blocks[0]));
    expect(keysOf(blocks[0]).length).toBeGreaterThanOrEqual(8);
  });
});
