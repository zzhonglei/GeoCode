import { afterEach, describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { getPermissionToolPresentation } from '@/components/chat/permissionToolPresentation';
import { describeSavePatterns } from '@/components/chat/permissionSummary';
import { BUILTIN_ACTIONS } from '@/components/sections/agents/agentPermissionModel';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import type { ToolPart, ToolState } from '@/lib/opencode/model';
import { toolDescription } from '@/lib/opencode/tools';
import { getToolMetadata } from '@/lib/toolHelpers';
import type { PermissionRequest } from '@/types/permission';

import { geoActionLabel } from './geoTools';
import { qgisRunView } from './qgisRun';
import { QgisRunRow } from './QgisRunRow';

// As the upstream tests do: Bun does not implement Vite's worker asset-query imports, which geerun's card reaches.
plugin({
  name: 'geo-permission-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { geoPermissionContent } = await import('./geoPermission');

const english = useI18nStore.getState().locale;
afterEach(() => useI18nStore.setState({ locale: english }));

const ALGORITHM = {
  id: 'native:truncatetable',
  name: 'Truncate table',
  description: 'Truncates a layer, by deleting all features from within the layer.',
  translations: {
    'zh-CN': {
      name: '快速清空表',
      description: '通过删除图层内的所有要素来清空图层。',
    },
    'zh-TW': {
      name: '截斷表格',
      description: '透過刪除圖層內的所有特徵來截斷圖層。',
    },
  },
};

const INPUT = {
  algorithm: ALGORITHM.id,
  parameters: {},
  description: '清空临时表',
};

type WithoutInput<State> = State extends ToolState ? Omit<State, 'input'> : never;

const part = (state: WithoutInput<ToolState>): ToolPart => ({
  id: 'prt_qgisrun',
  sessionID: 'ses_qgisrun',
  messageID: 'msg_qgisrun',
  type: 'tool',
  callID: 'call_qgisrun',
  tool: 'qgisrun',
  state: { ...state, input: INPUT },
});

const asking = (metadata: PermissionRequest['metadata']): PermissionRequest => ({
  id: 'per_qgisrun',
  sessionID: 'ses_qgisrun',
  action: 'qgisrun',
  resources: [],
  metadata,
});

const render = (element: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);

const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('GeoCode: qgisrun in the interface', () => {
  test('has its title, its row describing the step, and a permission rule of its own', () => {
    useI18nStore.setState({ locale: 'zh-TW' });
    expect(getToolMetadata('qgisrun').displayName).toBe('執行 QGIS 演算法');
    expect(geoActionLabel('qgisrun')).toBe('執行 QGIS 演算法');
    expect(BUILTIN_ACTIONS).toContain('qgisrun');
    expect(toolDescription('qgisrun', { description: ' 道路缓冲区 ' }, undefined)).toEqual({
      kind: 'text',
      value: '道路缓冲区',
    });
  });

  // Guards against showing GeoAgent's algorithm IDs to the user, in the header or on "always allow".
  test('asks to run the algorithm by the name the desktop QGIS gives it', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    expect(getPermissionToolPresentation(asking({ algorithm: ALGORITHM })).name).toBe('请求执行 QGIS 算法 快速清空表');
    useI18nStore.setState({ locale: 'en' });
    expect(getPermissionToolPresentation(asking({ algorithm: ALGORITHM })).name).toBe(
      'Request to run QGIS algorithm Truncate table',
    );
    expect(describeSavePatterns('qgisrun', ['native:truncatetable', '/Users/lei/*'])).toEqual([]);
    expect(describeSavePatterns('read', ['data/*'])).toEqual(['data/*']);
  });

  test('a card says why, what the algorithm does, what to heed, then its inputs, parameters and outputs', () => {
    const html = render(
      geoPermissionContent(
        asking({
          description: '清空临时表',
          algorithm: ALGORITHM,
          inputs: [{ name: 'INPUT', value: '/data/staging.gpkg|layername=poi' }],
          options: [
            { name: 'DISTANCE', value: 500 },
            { name: 'DISSOLVE', value: true },
          ],
          outputs: [
            { name: 'OUTPUT', value: '/exports/out_1.gpkg', external: true },
            { name: 'REPORT', value: '/data/report.html', external: false },
            { name: 'TABLE', value: 'postgis:dbname=gis table=t', external: false, place: 'postgres: dbname=gis' },
          ],
          external: ['/exports'],
          elsewhere: ['postgis:dbname=gis table=t'],
          guarded: true,
        }),
      ),
    );
    // A server render reads the store's first language, English.
    expect(text(html)).toBe(
      [
        'Reason: 清空临时表',
        'Purpose: Truncates a layer, by deleting all features from within the layer.',
        'Writes files in /exports, outside the project.',
        'Writes to a database or another place that is not a file: postgis:dbname=gis table=t',
        'This algorithm may change or affect your existing data.',
        'Input/data/staging.gpkg|layername=poi',
        'ParametersDISTANCE=500, DISSOLVE=true',
        'Output/exports/out_1.gpkg, /data/report.html, postgis:dbname=gis table=t',
      ].join(''),
    );
    expect(html).toContain('<span class="text-[var(--status-warning)]">/exports/out_1.gpkg</span>');
    expect(html).toContain('<span class="text-[var(--status-warning)]">postgis:dbname=gis table=t</span>');
    expect(html).not.toContain('native:truncatetable');
    expect(geoPermissionContent({ ...asking({}), action: 'read' })).toBeUndefined();
  });

  // Guards against reading the language anywhere but from the caller, which the React Compiler caches the row by.
  test('a running row names the algorithm in the language it is given, with its percentage', () => {
    const running = part({
      status: 'running',
      time: { start: Date.now() - 3000 },
      metadata: { algorithm: ALGORITHM, percent: 41 },
    });
    useI18nStore.setState({ locale: 'zh-CN' });
    expect(qgisRunView(running, 'zh-TW').algorithm?.name).toBe('截斷表格');
    // A server render reads the store's first language, English.
    const html = render(<QgisRunRow part={running} />);
    expect(text(html)).toContain('清空临时表Running Truncate table41%');
    expect(html).toContain('color:var(--tools-title)');
  });

  // Guards against counting the wait for the user's answer as the run's time.
  test('a row counts from when the run began, and not while the user is asked', () => {
    const asked = Date.now() - 60000;
    const began = Date.now() - 3000;
    const waiting = part({ status: 'running', time: { start: asked }, metadata: {} });
    expect(qgisRunView(waiting, 'en').start).toBeUndefined();
    expect(text(render(<QgisRunRow part={waiting} />))).toBe('清空临时表');
    const running = part({ status: 'running', time: { start: asked }, metadata: { started: began } });
    expect(qgisRunView(running, 'en').start).toBe(began);
  });

  test('an open row shows the facts, each message by its level, and how the run ended', () => {
    const view = qgisRunView(
      part({
        status: 'completed',
        output: '',
        time: { start: 0, end: 7200 },
        metadata: {
          algorithm: ALGORITHM,
          notes: ['Defaults used: RESAMPLING=0 (Nearest Neighbour)'],
          messages: [
            { level: 'info', text: 'GDAL command:' },
            { level: 'command', text: 'gdalwarp a.tif b.tif' },
            {
              level: 'warning',
              text: 'Feature 3 has invalid geometry.\nIt was skipped.',
            },
          ],
          outcome: 'finished',
          ending: 'Finished in 7 s.\nOutputs:\n- OUTPUT: /data/out_1.gpkg\n- COUNT: 3',
        },
      }),
      'en',
    );
    expect(view.bad).toBe(false);
    expect(view.lines).toEqual([
      { text: 'Defaults used: RESAMPLING=0 (Nearest Neighbour)', tone: 'plain', icon: false },
      { text: 'GDAL command:', tone: 'plain', icon: false },
      { text: 'gdalwarp a.tif b.tif', tone: 'command', icon: false },
      { text: 'Feature 3 has invalid geometry.', tone: 'warning', icon: true },
      { text: 'It was skipped.', tone: 'warning', icon: false },
      { text: '/data/out_1.gpkg', tone: 'success', icon: true },
      { text: 'COUNT: 3', tone: 'success', icon: true },
    ]);
  });

  test('a run that did not finish titles itself in red and says why, down to a stop only the interface tells', () => {
    const failed = qgisRunView(
      part({
        status: 'completed',
        output: '',
        time: { start: 0, end: 75000 },
        metadata: {
          algorithm: ALGORITHM,
          outcome: 'timeout',
          ending:
            'Stopped after 75 s, with no progress for the last 60 s.\nThese outputs may be incomplete:\n- /data/poi.gpkg',
        },
      }),
      'en',
    );
    expect(failed.bad).toBe(true);
    expect(failed.lines).toEqual([
      {
        text: 'Stopped after 75 s, with no progress for the last 60 s.',
        tone: 'error',
        icon: true,
      },
      { text: 'These outputs may be incomplete:', tone: 'warning', icon: true },
      { text: '/data/poi.gpkg', tone: 'warning', icon: false },
    ]);
    const stopped = qgisRunView(
      part({
        status: 'error',
        error: 'Tool execution interrupted',
        time: { start: 0, end: 133000 },
        metadata: {
          started: 13000,
          algorithm: ALGORITHM,
          messages: [{ level: 'info', text: 'started' }],
          percent: 12,
        },
      }),
      'en',
    );
    expect([stopped.bad, stopped.percent, stopped.lines.map((line) => line.text)]).toEqual([
      true,
      undefined,
      ['started', 'Stopped by the user after 120 s.'],
    ]);
    const refused = qgisRunView(
      part({
        status: 'completed',
        output: '',
        time: { start: 0, end: 300 },
        metadata: {
          outcome: 'refused',
          ending: 'native:buffer has no parameter DIST, so nothing was run.\nIts parameters are INPUT.',
        },
      }),
      'en',
    );
    expect(refused.lines.map((line) => [line.tone, line.icon])).toEqual([
      ['error', true],
      ['plain', false],
    ]);
    expect(
      render(
        <QgisRunRow
          part={part({
            status: 'error',
            error: 'QGIS is not configured.',
            time: { start: 0, end: 10 },
          })}
        />,
      ),
    ).toContain('color:var(--status-error)');
  });
});
