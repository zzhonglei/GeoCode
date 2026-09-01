/* --- GeoCode: guards a delete that runs during ordinary project opening.
 *
 * `openchamberConfig.ts` fell back to `<project>/.openchamber/openchamber.json`, copied it into
 * our own projects root and deleted the original. GeoCode has never written that path, so the
 * only file it can ever find there belongs to the user's OpenChamber — and the keys it carries
 * include shell commands bound to project buttons.
 *
 * The second case exists because the first would pass just as well against a mock that answered
 * nothing at all. --- */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const HOME = '/Users/tester';
const PROJECT = '/Users/tester/repo';

const files = new Map<string, string>();
const written: string[] = [];
const deleted: string[] = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (url: string, init?: RequestInit) => {
    const [route, query] = String(url).split('?');
    if (route.endsWith('/fs/home')) return Response.json({ home: HOME });
    if (route.endsWith('/fs/read')) {
      const target = decodeURIComponent(String(query).replace(/^path=/, ''));
      const content = files.get(target);
      return content === undefined ? new Response(null, { status: 404 }) : new Response(content);
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (route.endsWith('/fs/mkdir')) return Response.json({ success: true });
    if (route.endsWith('/fs/write')) {
      written.push(body.path);
      files.set(body.path, body.content);
      return Response.json({ success: true });
    }
    if (route.endsWith('/fs/delete')) {
      deleted.push(body.path);
      files.delete(body.path);
      return Response.json({ success: true });
    }
    return new Response(null, { status: 404 });
  }),
}));

const { PROJECTS_SEGMENTS } = await import('./shell-data-root');
const { createProjectIdFromPath } = await import('../lib/projectId');
const { getProjectActionsState, getWorktreeSetupCommands } = await import('../lib/openchamberConfig');

const legacyPath = `${PROJECT}/.openchamber/openchamber.json`;
const geocodePath = `${HOME}/${PROJECTS_SEGMENTS.join('/')}/${createProjectIdFromPath(PROJECT)}.json`;
const project = { id: 'p', path: PROJECT };

const CONFIG = JSON.stringify({
  'setup-worktree': ['npm ci'],
  projectActions: [{ id: 'serve', name: 'Serve', command: 'python -m http.server' }],
  projectActionsPrimaryId: 'serve',
});

describe('legacy project config', () => {
  beforeEach(() => {
    files.clear();
    written.length = 0;
    deleted.length = 0;
  });

  test('a project-local .openchamber config is neither read nor deleted', async () => {
    files.set(legacyPath, CONFIG);

    expect(await getWorktreeSetupCommands(project)).toEqual([]);
    expect(await getProjectActionsState(project)).toEqual({ actions: [], primaryActionId: null });

    expect(deleted).toEqual([]);
    expect(written).toEqual([]);
    expect(files.get(legacyPath)).toBe(CONFIG);
  });

  test('the same content is read when it sits under the GeoCode projects root', async () => {
    files.set(geocodePath, CONFIG);

    expect(await getWorktreeSetupCommands(project)).toEqual(['npm ci']);
    expect((await getProjectActionsState(project)).primaryActionId).toBe('serve');
  });
});
