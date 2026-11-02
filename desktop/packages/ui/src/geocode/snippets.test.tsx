import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { Window } from 'happy-dom';
import { pathToFileURL } from 'node:url';
import { OpenCode } from '@opencode/client';
import { ChatColumnSessionContext } from '@/components/chat/chatColumnSession';
import { dispatchFrameSelection } from '@/components/chat/message/frameSelection';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import type { Part } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';

// Guards against a merge bringing back a way to save a snippet: the app has no snippets, and the server refuses to
// store one.
const SAVE = 'Save as snippet';

// Bun needs the asset URL that Vite normally supplies to the real renderer.
plugin({
  name: 'geocode-snippets-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

// React DOM probes for a DOM when first imported; give it one, then restore the caller's globals.
const importWindow = new Window();
const importGlobals = ['window', 'document'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { TextSelectionMenu } = await import('@/components/chat/message/TextSelectionMenu');
const { default: MessageBody } = await import('@/components/chat/message/MessageBody');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const unavailable = (): never => { throw new Error('Message rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
};

// The globals a render reads, set to a fresh page for the length of one test.
const withPage = async (run: () => Promise<void> | void) => {
  const win = new Window({ url: 'http://localhost' });
  const names = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'CustomEvent', 'DOMRect', 'MutationObserver', 'ResizeObserver', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, CustomEvent: win.CustomEvent, DOMRect: win.DOMRect, MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  try {
    await run();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  }
};

describe('GeoCode: snippets', () => {
  test("a user's message offers no Save as snippet", () => withPage(async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => Response.json([]) });
    const question: Part = { id: 'text', sessionID: 'session', messageID: 'question', type: 'text', text: 'Map the rivers.' };
    try {
      await act(async () => root.render(
        <RuntimeAPIContext.Provider value={runtimeApis}>
          <SyncProvider sdk={sdk} directory="">
            <I18nProvider>
              <MessageBody
                messageId="question" parts={[question]} isUser isMessageCompleted
                isMobile={false} copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()}
                onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="completed" allowAnimation={false}
                hasTextContent onCopyMessage={() => {}} onSaveAsSnippet={() => {}} userMessagePart="actions"
              />
            </I18nProvider>
          </SyncProvider>
        </RuntimeAPIContext.Provider>,
      ));
      // The row ChatMessage draws under the message, where Save as snippet sits beside Copy.
      expect(document.body.innerHTML).toContain('Copy message text');
      expect(document.body.innerHTML.includes(SAVE)).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  }));

  test('a selection offers no Save as snippet', () => withPage(async () => {
    const container = document.createElement('div');
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.append(container, host);
    const root = createRoot(container);
    const sdk = OpenCode.make({ baseUrl: 'http://selection.test', fetch: () => new Promise<Response>(() => undefined) });
    try {
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory="/repo">
          <I18nProvider>
            <ChatColumnSessionContext.Provider value={{ sessionId: 'session-1', directory: '/repo' }}>
              <TextSelectionMenu containerRef={{ current: host }} readingKey="message-1" canReadAloud={false} frameSelections />
            </ChatColumnSessionContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      ));
      await act(async () => {
        dispatchFrameSelection(frame, { text: 'picked words', rect: { top: 10, left: 20, width: 80, height: 16 } });
      });
      expect(document.body.textContent).toContain('Comment');
      expect(document.body.innerHTML.includes(SAVE)).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  }));
});
