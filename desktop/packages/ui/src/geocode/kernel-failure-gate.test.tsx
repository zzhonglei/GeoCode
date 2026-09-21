/* --- GeoCode: existing and late-opened Mini Chat roots must replace chat on kernel failure. --- */
import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { I18nProvider } from '@/lib/i18n';
import { GeoCodeKernelFailureGate } from './GeoCodeKernelFailureGate';
import { KERNEL_LOST_EVENT } from './kernel-lost';
import type { KernelFailure } from './GeoCodeKernelFailureScreen';

test('Mini Chat wraps its independent root in the failure gate', () => {
  const source = readFileSync(new URL('../apps/renderElectronMiniChatApp.tsx', import.meta.url), 'utf8');
  expect(/<GeoCodeKernelFailureGate>\s*<SessionAuthGate>\s*<ElectronMiniChatApp/.test(source)).toBe(true);
});

test('the gate handles live failures and existing records, and unmounts the chat', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let record: KernelFailure | null = null;
  const commands: string[] = [];
  Object.assign(dom, {
    __OPENCHAMBER_DESKTOP__: { invoke: async (command: string) => {
      commands.push(command);
      return command === 'geocode_kernel_failure' ? record : true;
    } },
    __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
  });
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
    CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let mounted = 0;
  function Chat() {
    React.useEffect(() => { mounted++; return () => { mounted--; }; }, []);
    return <span>chat fixture</span>;
  }
  const render = (key: string) => root.render(
    <I18nProvider><GeoCodeKernelFailureGate key={key}><Chat /></GeoCodeKernelFailureGate></I18nProvider>,
  );
  try {
    await act(async () => render('existing'));
    expect(mounted).toBe(1);
    expect(container.textContent).toContain('chat fixture');
    record = { phase: 'running', message: 'synthetic kernel exit', output: [], logPath: '/synthetic/kernel.log', at: '' };
    await act(async () => { dom.dispatchEvent(new dom.Event(KERNEL_LOST_EVENT)); });
    expect(mounted).toBe(0);
    expect(container.querySelector('h1')?.textContent).toBe('The GeoCode kernel stopped unexpectedly');
    expect(container.textContent).toContain(record.logPath!);
    expect(container.textContent).not.toContain('chat fixture');
    await act(async () => render('late'));
    expect(mounted).toBe(0);
    expect(container.querySelector('h1')?.textContent).toBe('The GeoCode kernel stopped unexpectedly');
    const reveal = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Show in folder'));
    await act(async () => reveal?.click());
    expect(commands).toContain('desktop_reveal_path');
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
