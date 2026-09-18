/* --- GeoCode: project actions and worktree setup commands must stay closed at every mount in the renderer, including
 * one a merge adds or rewrites (geocode/advanced-project-surface.ts, docs/DESKTOP.md §7.3). --- */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT_ACTIONS_OFFERED, WORKTREE_SETUP_COMMANDS_OFFERED } from './advanced-project-surface';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
  if (!/\.tsx?$/.test(entry.name) || /\.(test|bench)\./.test(entry.name)) return [];
  return [full];
});

// A JSX mount, not a type parameter such as `React.FC<WorktreeSectionContentProps>`.
const mountPattern = (component: string) => new RegExp(`<${component}[\\s/>]`, 'g');
const countMounts = (text: string, component: string) => (text.match(mountPattern(component)) ?? []).length;

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

const mounts = (component: string) => sources(SRC)
  .map((file) => ({ file: path.relative(SRC, file), text: readFileSync(file, 'utf8') }))
  .filter((entry) => countMounts(entry.text, component) > 0);

// Each place `needle` appears must follow `guard` inside the same JSX expression: a closing line
// between the two would mean the guard ended before the thing it was meant to hold.
const unguardedUses = (needle: string, guard: string) => sources(SRC).flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]
    .filter((match) => {
      const at = match.index ?? 0;
      const start = text.lastIndexOf(guard, at);
      if (start < 0) return true;
      const between = text.slice(start, at);
      return between.includes('{/* --- /GeoCode --- */}') || /^\s*\)(\s*:\s*null)?\}\s*$/m.test(between);
    })
    .map(() => path.relative(SRC, file));
});

describe('the project settings panel stays narrow', () => {
  test('project actions are not offered', () => {
    expect(PROJECT_ACTIONS_OFFERED).toBe(false);
  });

  test('every mount of the actions section sits behind the guard', () => {
    const unguarded = mounts('ProjectActionsSection')
      .filter(({ text }) => countMounts(text, 'ProjectActionsSection')
        !== occurrences(text, '!PROJECT_ACTIONS_OFFERED ? null : <ProjectActionsSection'))
      .map(({ file }) => file);
    expect(unguarded).toEqual([]);
  });

  test('every mount of the actions button sits behind the guard', () => {
    expect(mounts('ProjectActionsButton').length).toBeGreaterThan(0);
    expect(unguardedUses('<ProjectActionsButton', '!PROJECT_ACTIONS_OFFERED ? null :')).toEqual([]);
  });

  test('worktree setup commands are not offered', () => {
    expect(WORKTREE_SETUP_COMMANDS_OFFERED).toBe(false);
  });

  test('the Multi-Run launcher neither edits nor loads setup commands', () => {
    const editors = sources(SRC).filter((file) => readFileSync(file, 'utf8').includes("t('multirun.launcher.setupCommands.label')"));
    expect(editors.length).toBeGreaterThan(0);
    expect(unguardedUses("t('multirun.launcher.setupCommands.label')", '!WORKTREE_SETUP_COMMANDS_OFFERED ? null : (')).toEqual([]);
    const launcher = readFileSync(path.join(SRC, 'components/multirun/MultiRunLauncher.tsx'), 'utf8');
    const load = launcher.indexOf('await resolveWorktreeSetupCommands(');
    expect(load).toBeGreaterThan(-1);
    const effect = launcher.lastIndexOf('React.useEffect(', load);
    expect(launcher.slice(effect, load)).toContain('if (!WORKTREE_SETUP_COMMANDS_OFFERED) return;');
  });

  test('no mount of the worktree section asks for the setup commands', () => {
    const found = mounts('WorktreeSectionContent');
    expect(found.length).toBeGreaterThan(0);
    const withSetup = found
      .filter(({ text }) => countMounts(text, 'WorktreeSectionContent')
        !== occurrences(text, 'sections="list-only"'))
      .map(({ file }) => file);
    expect(withSetup).toEqual([]);
  });
});
