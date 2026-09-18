/* --- GeoCode: guards against the shell listing skills from, writing skills into or deleting skills from
 * `.claude/skills` and `.agents/skills`, which belong to other agent tools (docs/PATHS.md §7). --- */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KERNEL_PROJECT_DIR } from './kernel-roots.js';

let fakeHome;
let configHome;
const saved = {};
let skills;

const writeSkill = (dir, name) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${name} description`, '---', '', 'Body.', ''].join('\n'), 'utf8');
  return path.join(dir, 'SKILL.md');
};

beforeAll(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-external-skills-home-'));
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-external-skills-config-'));
  for (const key of ['HOME', 'XDG_CONFIG_HOME']) saved[key] = process.env[key];
  process.env.HOME = fakeHome;
  process.env.XDG_CONFIG_HOME = configHome;
  // Imported after the environment is in place: the module resolves its config root at import.
  skills = await import('../lib/opencode/skills.js');
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [fakeHome, configHome]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('external skill libraries', () => {
  it('does not discover them at either scope', () => {
    writeSkill(path.join(fakeHome, '.claude', 'skills', 'home-claude-skill'), 'home-claude-skill');
    writeSkill(path.join(fakeHome, '.agents', 'skills', 'home-agents-skill'), 'home-agents-skill');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-external-skills-project-'));
    try {
      fs.mkdirSync(path.join(project, '.git'));
      writeSkill(path.join(project, '.claude', 'skills', 'project-claude-skill'), 'project-claude-skill');
      writeSkill(path.join(project, '.agents', 'skills', 'project-agents-skill'), 'project-agents-skill');

      const names = skills.discoverSkills(project).map((skill) => skill.name);
      for (const name of ['home-claude-skill', 'home-agents-skill', 'project-claude-skill', 'project-agents-skill']) {
        expect([name, names.includes(name)]).toEqual([name, false]);
      }
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('never deletes a skill it did not create', () => {
    // Same name in all three roots, or the delete has nothing of theirs to reach.
    const name = 'review';
    const claudeSkill = writeSkill(path.join(fakeHome, '.claude', 'skills', name), name);
    const agentsSkill = writeSkill(path.join(fakeHome, '.agents', 'skills', name), name);
    skills.createSkill(name, { description: 'ours', instructions: 'Body.' }, null, 'user');

    skills.deleteSkill(name, null);

    expect(fs.existsSync(claudeSkill)).toBe(true);
    expect(fs.existsSync(agentsSkill)).toBe(true);
    // Ours is gone, so this cannot pass by deleting nothing.
    expect(skills.discoverSkills(null).map((skill) => skill.name)).not.toContain(name);
  });

  it('never deletes a project skill it did not create', () => {
    const name = 'lint';
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-external-skills-project-'));
    try {
      fs.mkdirSync(path.join(project, '.git'));
      const claudeSkill = writeSkill(path.join(project, '.claude', 'skills', name), name);
      const agentsSkill = writeSkill(path.join(project, '.agents', 'skills', name), name);
      skills.createSkill(name, { description: 'ours', instructions: 'Body.' }, project, 'project');

      skills.deleteSkill(name, project);

      expect(fs.existsSync(claudeSkill)).toBe(true);
      expect(fs.existsSync(agentsSkill)).toBe(true);
      expect(skills.discoverSkills(project).map((skill) => skill.name)).not.toContain(name);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('creates into our own directory even when asked for .agents', () => {
    const name = 'redirected';
    skills.createSkill(name, { description: 'ours', instructions: 'Body.', source: 'agents' }, null, 'user');

    expect(fs.existsSync(path.join(fakeHome, '.agents', 'skills', name, 'SKILL.md'))).toBe(false);
    const found = skills.discoverSkills(null).find((skill) => skill.name === name);
    expect(found?.source).toBe('opencode');
  });

  it('installs from the catalog into our own project directory even when asked for .agents', async () => {
    // `insteadOf` points the GitHub address at a local repository, so the clone needs no network.
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-catalog-repository-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-catalog-project-'));
    const gitConfig = path.join(fakeHome, 'catalog.gitconfig');
    fs.writeFileSync(gitConfig, `[url "${repository}"]\n\tinsteadOf = https://github.com/geocode-probe/skills.git\n`);
    const previous = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const git = (...args) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' });

    try {
      writeSkill(path.join(repository, 'skills', 'catalog-probe'), 'catalog-probe');
      git('init', '-q');
      git('add', '.');
      git('-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'probe');

      const { installSkillsFromRepository } = await import('../lib/skills-catalog/install.js');
      const result = await installSkillsFromRepository({
        source: 'geocode-probe/skills',
        scope: 'project',
        targetSource: 'agents',
        workingDirectory: project,
        userSkillDir: path.join(configHome, 'skills'),
        selections: [{ skillDir: 'skills/catalog-probe' }],
      });

      expect(result).toMatchObject({ ok: true });
      expect(fs.existsSync(path.join(project, KERNEL_PROJECT_DIR, 'skills', 'catalog-probe', 'SKILL.md'))).toBe(true);
      for (const foreign of ['.agents', '.opencode']) {
        expect([foreign, fs.existsSync(path.join(project, foreign))]).toEqual([foreign, false]);
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const dir of [repository, project]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
