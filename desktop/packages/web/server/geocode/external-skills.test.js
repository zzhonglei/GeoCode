/* --- GeoCode: `.claude/skills` and `.agents/skills` belong to other agent tools (docs/PATHS.md §7).
 *
 * The kernel already refuses to load them — `runtime-flags.ts` turns both isolation flags ON — so
 * the shell listing them told the user about capability GeoAgent does not have. Closing that is
 * four things at once, and an earlier attempt proved they cannot be done one at a time: dropping
 * only the managed-roots list left a skill that could be created into `.agents` and then not
 * renamed, which is worse than either end state.
 *
 * The delete case is the one that matters most. `deleteSkill` takes no source and removed the
 * skill from EVERY root it knew, so deleting a GeoCode skill named `foo` also deleted the user's
 * Claude Code skill named `foo`, recursively, from their home directory. Asserting that a file we
 * did not create is still there afterwards is the only form of that check worth having. --- */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    // The destructive case. Same name in all three places, which is the collision that made this
    // dangerous: `.claude/skills` entries are commonly symlinks into `.agents/skills`, so a user
    // with a skill called `review` had it in both.
    const name = 'review';
    const claudeSkill = writeSkill(path.join(fakeHome, '.claude', 'skills', name), name);
    const agentsSkill = writeSkill(path.join(fakeHome, '.agents', 'skills', name), name);
    skills.createSkill(name, { description: 'ours', instructions: 'Body.' }, null, 'user');

    skills.deleteSkill(name, null);

    expect(fs.existsSync(claudeSkill)).toBe(true);
    expect(fs.existsSync(agentsSkill)).toBe(true);
    // Ours is gone, so the delete did happen and this is not passing by doing nothing.
    expect(skills.discoverSkills(null).map((skill) => skill.name)).not.toContain(name);
  });

  it('never deletes a project skill it did not create', () => {
    // The same collision inside the user's repository, which is where the project halves reach.
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
});
