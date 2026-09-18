/* --- GeoCode: guards against the shell scheduling, deleting or rewriting loop definitions another agent tool
 * keeps under `.agents/loops` (docs/PATHS.md §7). --- */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Must parse as a valid loop, or reconciliation creates no loop task even with discovery reopened.
const LOOP = [
  '---',
  'name: Nightly digest',
  'schedule: "0 9 * * *"',
  'model: anthropic/claude-sonnet-5',
  '---',
  '',
  'Summarise yesterday.',
  '',
].join('\n');

let home;
let project;
let projectsDir;
let savedHome;
let loops;
let projectConfig;

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const writeLoop = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'digest.md');
  fs.writeFileSync(file, LOOP, 'utf8');
  return file;
};

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-loops-'));
  project = path.join(home, 'repo');
  projectsDir = path.join(home, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  savedHome = process.env.HOME;
  process.env.HOME = home;

  loops = await import('../lib/scheduled-tasks/loops.js');
  projectConfig = await import('../lib/projects/project-config.js');
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agent loops', () => {
  it('runs nothing defined under .agents/loops, in the home directory or in the project', () => {
    writeLoop(path.join(home, '.agents', 'loops'));
    writeLoop(path.join(project, '.agents', 'loops'));

    expect(loops.discoverLoopFiles(project)).toEqual([]);
    expect(loops.discoverLoops(project)).toEqual([]);
  });

  it('leaves the definition files exactly as it found them', () => {
    // Stays green with discovery reopened, since discovery only reads; it guards a discovery that starts writing.
    const userFile = writeLoop(path.join(home, '.agents', 'loops'));
    const projectFile = writeLoop(path.join(project, '.agents', 'loops'));
    const before = [digest(userFile), digest(projectFile)];

    loops.discoverLoops(project);

    expect(fs.existsSync(userFile)).toBe(true);
    expect(fs.existsSync(projectFile)).toBe(true);
    expect([digest(userFile), digest(projectFile)]).toEqual(before);
  });

  it('leaves no task carrying a loop file, which is what both writes look up', async () => {
    let created = 0;
    const runtime = projectConfig.createProjectConfigRuntime({
      fsPromises,
      path,
      projectsDirPath: projectsDir,
      createTaskID: () => `task-${++created}`,
    });

    await runtime.upsertScheduledTask('proj', {
      name: 'Made in the UI',
      enabled: true,
      schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
      execution: { prompt: 'run', providerID: 'anthropic', modelID: 'claude-sonnet-5' },
    });

    const reconciled = await runtime.reconcileLoopTasks('proj', loops.discoverLoops(project));

    // Closing loops must not remove tasks made in the UI.
    expect(reconciled.map((task) => task.name)).toEqual(['Made in the UI']);
    expect(reconciled.filter((task) => task.loopFile)).toEqual([]);
  });
});
