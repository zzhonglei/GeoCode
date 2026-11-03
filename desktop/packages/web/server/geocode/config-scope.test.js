import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Guards against the shell reading, writing or deleting config where the kernel does not look: above the session
// directory, or in another product's `.claude`, `.agents` or `.opencode` directory.
const saved = { HOME: process.env.HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, OPENCODE_CONFIG: process.env.OPENCODE_CONFIG };
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
  process.env.HOME = home;
  process.env.OPENCODE_CONFIG_DIR = config;
  delete process.env.OPENCODE_CONFIG;
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  for (const dir of [path.join(config, 'skills'), path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills'), path.join(session, '.claude', 'skills'), path.join(session, '.agents', 'skills')]) {
    skill(dir, 'dup');
  }
  skill(path.join(session, '.geocode', 'skills'), 'own');
  skill(path.join(session, '.opencode', 'skills'), 'opencode-only');
  skill(path.join(config, 'skill'), 'legacy');
  skill(path.join(home, '.claude', 'skills'), 'claude-only');
  skill(path.join(home, '.geocode', 'skills'), 'home-geocode');
  skill(path.join(repo, '.geocode', 'skills'), 'above');
  fs.writeFileSync(path.join(repo, '.geocode', 'geocode.json'), '{ "websearch": false }\n');
  fs.writeFileSync(path.join(session, '.opencode', 'opencode.json'), '{ "websearch": false }\n');
  // Imported only now: shared.js reads OPENCODE_CONFIG_DIR when it loads.
  skills = await import('../lib/opencode/skills.js');
  websearch = await import('../lib/opencode/websearch-config.js');
});

afterAll(() => {
  for (const key of ['HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG']) restore(process.env, key, saved[key]);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('GeoCode: findWorktreeRoot', () => {
  it('reads no project config above the session directory', () => {
    expect(websearch.getWebSearchSource(session).projectPath).toBe(null);
  });
});

describe('GeoCode: skill directories', () => {
  it('lists only the global and session directories', async () => {
    expect((await skills.discoverSkills(session)).map((found) => found.path).sort()).toEqual([
      path.join(config, 'skill', 'legacy', 'SKILL.md'),
      path.join(config, 'skills', 'dup', 'SKILL.md'),
      path.join(session, '.geocode', 'skills', 'own', 'SKILL.md'),
    ]);
  });

  it('edits only in those directories', async () => {
    const foreign = path.join(home, '.claude', 'skills', 'dup', 'SKILL.md');
    const before = fs.readFileSync(foreign, 'utf8');
    await expect(skills.updateSkill('dup', { description: 'changed' }, session, foreign)).rejects.toThrow();
    expect(fs.readFileSync(foreign, 'utf8')).toBe(before);

    for (const target of [path.join(session, '.geocode', 'skills', 'own', 'SKILL.md'), path.join(config, 'skill', 'legacy', 'SKILL.md')]) {
      await skills.updateSkill(path.basename(path.dirname(target)), { description: 'changed' }, session, target);
      expect(fs.readFileSync(target, 'utf8')).toContain('changed');
    }
  });

  it('deletes and creates only in those directories', async () => {
    skills.deleteSkill('dup', session);
    expect(fs.existsSync(path.join(config, 'skills', 'dup'))).toBe(false);
    for (const dir of [path.join(home, '.claude'), path.join(home, '.agents'), path.join(session, '.claude'), path.join(session, '.agents')]) {
      expect(fs.existsSync(path.join(dir, 'skills', 'dup', 'SKILL.md'))).toBe(true);
    }

    await skills.createSkill('made-user', { source: 'agents', description: 'made' }, session, 'user');
    await skills.createSkill('made-project', { source: 'agents', description: 'made' }, session, 'project');
    expect(fs.existsSync(path.join(config, 'skills', 'made-user', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(session, '.geocode', 'skills', 'made-project', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'made-user'))).toBe(false);
    expect(fs.existsSync(path.join(session, '.agents', 'skills', 'made-project'))).toBe(false);
  });

  // Guards against the project's path falling back to upstream's `.opencode`.
  it('creates a project skill from the default source in the kernel directory', async () => {
    await skills.createSkill('made-default', { description: 'made' }, session, 'project');
    expect(fs.existsSync(path.join(session, '.geocode', 'skills', 'made-default', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(session, '.opencode', 'skills', 'made-default'))).toBe(false);
  });

  it('edits no skill that only another product has', async () => {
    const foreign = path.join(session, '.opencode', 'skills', 'opencode-only', 'SKILL.md');
    const before = fs.readFileSync(foreign, 'utf8');
    await skills.updateSkill('opencode-only', { description: 'changed' }, session).catch(() => undefined);
    expect(fs.readFileSync(foreign, 'utf8')).toBe(before);
  });

  // Guards against deleting a folder outside them through a skill whose name is a path.
  it('deletes nothing outside them for a name that is a path', () => {
    expect(() => skills.deleteSkill('../../.claude/skills/dup', session)).toThrow();
    expect(fs.existsSync(path.join(session, '.claude', 'skills', 'dup', 'SKILL.md'))).toBe(true);
  });
});

describe('GeoCode: MCP servers', () => {
  const server = (name) => `${JSON.stringify({ mcp: { [name]: { type: 'local', command: ['true'] } } })}\n`;
  let project;
  let mcp;

  beforeAll(async () => {
    const parent = path.join(root, 'mcp');
    project = path.join(parent, 'project');
    fs.mkdirSync(path.join(project, '.geocode'), { recursive: true });
    fs.mkdirSync(path.join(project, '.opencode'), { recursive: true });
    fs.writeFileSync(path.join(project, 'geocode.json'), server('plain'));
    fs.writeFileSync(path.join(project, '.geocode', 'geocode.json'), server('own'));
    fs.writeFileSync(path.join(parent, 'geocode.json'), server('above'));
    fs.writeFileSync(path.join(project, 'opencode.json'), server('opencode-file'));
    fs.writeFileSync(path.join(project, '.opencode', 'opencode.json'), server('opencode-dir'));
    mcp = await import('../lib/opencode/mcp.js');
  });

  it('lists only those of the project directory\'s own config, as the kernel reads them', () => {
    expect(mcp.listMcpConfigs(project).map((entry) => [entry.name, entry.scope]).sort()).toEqual([['own', 'project'], ['plain', 'project']]);
  });

  it('changes no other product\'s config file', () => {
    const theirs = path.join(project, 'opencode.json');
    const before = fs.readFileSync(theirs, 'utf8');
    expect(() => mcp.deleteMcpConfig('opencode-file', project)).toThrow();
    expect(fs.readFileSync(theirs, 'utf8')).toBe(before);
  });
});
