import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProjectConfigRuntime } from '../lib/projects/project-config.js';
import { createChatsScope, CHATS_SCOPE_PUBLIC_ID } from '../lib/scheduled-tasks/chats-scope.js';
import { registerScheduledTaskRoutes } from '../lib/scheduled-tasks/routes.js';
import { createScheduledTasksRuntime } from '../lib/scheduled-tasks/runtime.js';
import { createScheduledTaskService } from '../lib/scheduled-tasks/service.js';

let root;
let chats;
let scheduler;
let server;
let origin;
const task = (extra = {}) => ({
  name: 'Fixture',
  enabled: false,
  schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' },
  execution: { prompt: 'Fixture prompt', providerID: 'fake', modelID: 'fake' },
  ...extra,
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-tasks-'));
  chats = createChatsScope(path.join(root, 'chats'));
  const config = createProjectConfigRuntime({ fsPromises: fs.promises, path, projectsDirPath: path.join(root, 'projects') });
  const projects = [{ id: 'proj', path: path.join(root, 'repo') }];
  scheduler = createScheduledTasksRuntime({
    projectConfigRuntime: config,
    chatsScope: chats,
    listProjects: async () => projects,
    buildOpenCodeUrl: () => 'http://127.0.0.1:1',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
  });
  const service = createScheduledTaskService({
    projectConfigRuntime: config,
    scheduledTasksRuntime: scheduler,
    chatsScope: chats,
    readSettingsFromDiskMigrated: async () => ({ projects }),
    sanitizeProjects: (value) => value,
  });
  const app = express();
  app.use(express.json());
  registerScheduledTaskRoutes(app, { scheduledTaskService: service, scheduledTasksRuntime: scheduler });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}/api/projects/${encodeURIComponent(CHATS_SCOPE_PUBLIC_ID)}/scheduled-tasks`;
});

afterEach(async () => {
  scheduler.stop();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GeoCode: scheduled tasks name no loop file', () => {
  // A task's loopFile is a path the loop endpoints rewrite or delete: one saved through the API, or left in a record, must not reach a file.
  it('deletes no file a task names, whether sent or already stored', async () => {
    const target = path.join(root, 'other-tool-file.md');
    fs.writeFileSync(target, 'Not GeoCode.');
    const sent = await fetch(origin, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: task({ loopFile: target }) }) });
    const sentID = (await sent.json()).task?.id;
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'projects', `${chats.id}.json`), 'utf8'));
    stored.scheduledTasks.push({ ...task({ loopFile: target }), id: 'stored' });
    fs.writeFileSync(path.join(root, 'projects', `${chats.id}.json`), JSON.stringify(stored));

    expect(sent.ok).toBe(true);
    for (const id of [sentID, 'stored']) {
      // A missing route or task would also leave the file alone, without reaching the loop-file handler.
      expect((await fetch(`${origin}/${id}/loop-file`, { method: 'DELETE' })).status).not.toBe(404);
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('Not GeoCode.');
  });
});
