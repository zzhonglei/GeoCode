import React, { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Metadata, Session } from '@/lib/opencode/model';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

// Guards against the overview reading background commands but not Earth Engine runs: a session whose agent is idle
// while its run goes on would look done, and Mark all done would end it.
test('GeoCode: the overview counts a run in the background as running, as it counts a background command', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    MutationObserver: dom.MutationObserver, KeyboardEvent: dom.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({}), originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { I18nProvider } = await import('@/lib/i18n');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
  const { OverviewPage } = await import('@/components/overview/OverviewView');
  const { applyGeeRuns, resetGeeRuns } = await import('./backgroundGeeRuns');

  // Idle, read, and suggested done: without its run it would look done.
  const metadata: Metadata = { openchamber: { work: { state: 'open', openedAt: 1, suggestDoneAt: NOW } } };
  const session: Session = {
    id: 'ses_ndvi', directory: '/repo', projectID: 'project', title: 'NDVI of Taipei', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW - 2 * HOUR, updated: NOW - 2 * HOUR, idle: NOW - 2 * HOUR, viewed: NOW - 2 * HOUR },
    metadata,
  };
  useGlobalSessionsStore.getState().applySnapshot([session], [], 'ready');
  resetGeeRuns();
  applyGeeRuns({
    revision: 1,
    runs: [{ id: 'job_1', sessionID: 'ses_ndvi', description: 'NDVI', startedAt: NOW - HOUR, directory: '/repo' }],
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    globalThis.fetch = originalFetch;
    resetGeeRuns();
  };

  await act(async () => root.render(
    <RuntimeAPIContext.Provider value={createWebAPIs()}>
      <I18nProvider>
        <TooltipProvider>
          <OverviewPage layout="page" onLeave={() => undefined} />
        </TooltipProvider>
      </I18nProvider>
    </RuntimeAPIContext.Provider>,
  ));

  const text = container.textContent ?? '';
  expect(text).toContain('NDVI of Taipei');
  expect(text).toContain('background command');
  expect(/looks? done/.test(text)).toBe(false);
  expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Mark all done')).toBe(false);
});
