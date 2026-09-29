import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Guards against the shell reading, writing or deleting config where the kernel does not look: above the session
// directory, or in another product's `.claude` or `.agents` directory.
const saved = { electron: process.versions.electron, HOME: process.env.HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, OPENCODE_CONFIG: process.env.OPENCODE_CONFIG };
let root;
let home;
let config;
let session;
let skills;
let websearch;

const skill = (dir, name) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nBody.\n`);
};

const restore = (target, key, value) => {
  if (value === undefined) delete target[key];
  else target[key] = value;
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-config-scope-'));
  home = path.join(root, 'home');
  config = path.join(root, 'config');
  const repo = path.join(root, 'repo');
  session = path.join(repo, 'sub');
  process.versions.electron = 'test';
  process.env.HOME = home;
  process.env.OPENCODE_CONFIG_DIR = config;
  delete process.env.OPENCODE_CONFIG;
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  for (const dir of [path.join(config, 'skills'), path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills'), path.join(session, '.claude', 'skills'), path.join(session, '.agents', 'skills')]) {
    skill(dir, 'dup');
  }
  skill(path.join(session, '.opencode', 'skills'), 'own');
  skill(path.join(config, 'skill'), 'legacy');
  skill(path.join(home, '.claude', 'skills'), 'claude-only');
  skill(path.join(home, '.opencode', 'skills'), 'home-opencode');
  skill(path.join(repo, '.opencode', 'skills'), 'above');
  fs.writeFileSync(path.join(repo, '.opencode', 'opencode.json'), '{ "websearch": false }\n');
  // Imported only now: shared.js reads OPENCODE_CONFIG_DIR when it loads.
  skills = await import('../lib/opencode/skills.js');
  websearch = await import('../lib/opencode/websearch-config.js');
});

afterAll(() => {
  restore(process.versions, 'electron', saved.electron);
  for (const key of ['HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG']) restore(process.env, key, saved[key]);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('GeoCode: findWorktreeRoot', () => {
  it('reads no project config above the session directory', () => {
    expect(websearch.getWebSearchSource(session).projectPath).toBe(null);
  });
});

describe('GeoCode: skill directories', () => {
  it('lists only the global and session directories', () => {
    expect(skills.discoverSkills(session).map((found) => found.path).sort()).toEqual([
      path.join(config, 'skill', 'legacy', 'SKILL.md'),
      path.join(config, 'skills', 'dup', 'SKILL.md'),
      path.join(session, '.opencode', 'skills', 'own', 'SKILL.md'),
    ]);
  });

  it('edits only in those directories', () => {
    const foreign = path.join(home, '.claude', 'skills', 'dup', 'SKILL.md');
    const before = fs.readFileSync(foreign, 'utf8');
    expect(() => skills.updateSkill('dup', { description: 'changed' }, session, foreign)).toThrow(/outside the skill directories/);
    expect(fs.readFileSync(foreign, 'utf8')).toBe(before);

    for (const target of [path.join(session, '.opencode', 'skills', 'own', 'SKILL.md'), path.join(config, 'skill', 'legacy', 'SKILL.md')]) {
      skills.updateSkill(path.basename(path.dirname(target)), { description: 'changed' }, session, target);
      expect(fs.readFileSync(target, 'utf8')).toContain('changed');
    }
  });

  it('deletes and creates only in those directories', () => {
    skills.deleteSkill('dup', session);
    expect(fs.existsSync(path.join(config, 'skills', 'dup'))).toBe(false);
    for (const dir of [path.join(home, '.claude'), path.join(home, '.agents'), path.join(session, '.claude'), path.join(session, '.agents')]) {
      expect(fs.existsSync(path.join(dir, 'skills', 'dup', 'SKILL.md'))).toBe(true);
    }

    skills.createSkill('made-user', { source: 'agents', description: 'made' }, session, 'user');
    skills.createSkill('made-project', { source: 'agents', description: 'made' }, session, 'project');
    expect(fs.existsSync(path.join(config, 'skills', 'made-user', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(session, '.opencode', 'skills', 'made-project', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'made-user'))).toBe(false);
    expect(fs.existsSync(path.join(session, '.agents', 'skills', 'made-project'))).toBe(false);
  });
});
