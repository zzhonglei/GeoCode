import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import { sessionMessageReference, sessionReference } from '@/components/chat/composer/sessionReferences';
import { MarkdownLink } from '@/components/chat/markdown/MarkdownLink';
import { MarkdownPresentationContext, type MarkdownPresentation } from '@/components/chat/markdown/MarkdownPresentationContext';
import { createMarkdownCodePlugin } from '@/components/chat/markdown/streamdownCode';
import { parseUiBlock } from '@/components/chat/uiBlocks/catalog';
import { UI_BLOCK_EXAMPLES, buildUiBlocksGuidance } from '@/components/chat/uiBlocks/guidance';
import { UI_BLOCKS_GUIDANCE_PATH, renderUiBlocksGuidanceModule } from '@/components/chat/uiBlocks/guidanceModule';
import { I18nProvider } from '@/lib/i18n';
import { getDefaultMagicPromptTemplate, loadMagicPrompts } from '@/lib/magicPrompts';
import { buildAgentHref } from '@/lib/messages/inlineMessageLinks';
import { getDefaultTheme } from '@/lib/theme/themes';

const requests: string[] = [];
spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  requests.push(input.toString());
  return new Response('{}', { status: 404 });
});

afterEach(() => {
  requests.length = 0;
});

// Guards against the slash commands, review and commit messages failing: the prompts' read now throws instead of falling
// back to the built-in text, and the endpoint it reads is closed.
describe('GeoCode: magic prompts', () => {
  test('render the built-in text without asking the server', async () => {
    const prompts = await loadMagicPrompts('/repo');
    expect(prompts.render('git.commit.generate.visible')).toBe(getDefaultMagicPromptTemplate('git.commit.generate.visible'));
    expect(requests).toEqual([]);
  });
});

// Guards against a mention of another session telling the model of OpenChamber, or of a tool by upstream's name.
describe('GeoCode: a session mention', () => {
  test('names GeoCode and its tool', () => {
    const session = { id: 'ses_1', title: 'Roads' };
    const message: Parameters<typeof sessionMessageReference>[1] = {
      info: { id: 'msg_1', role: 'system' },
      parts: [{ id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'Done.' }],
    };
    const texts = [sessionReference(session).contextText, sessionMessageReference(session, message)?.contextText ?? ''];
    expect(/openchamber|opencode/i.test(texts.join('\n'))).toBe(false);
    expect(texts.join('\n')).toContain('the geocode tool');
  });
});

// The link reads the page's own origin as it renders.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator });

// A reply on screen, as MarkdownContent presents it.
const reply: MarkdownPresentation = {
  directory: '/repo',
  fileReferences: false,
  fileNavigation: false,
  settled: true,
  loopbackPreview: true,
  theme: getDefaultTheme(false),
  mermaidControls: {},
  confirmFile: async () => null,
  code: createMarkdownCodePlugin({ isVSCode: false }),
  uiBlocks: false,
  uiBlockReply: null,
};

// Guards against a mention of an agent in a reply linking to OpenCode's documentation.
describe('GeoCode: an agent mention in a reply', () => {
  test('names the agent without a link', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <MarkdownPresentationContext.Provider value={reply}>
          <MarkdownLink href={buildAgentHref('build')}>@build</MarkdownLink>
        </MarkdownPresentationContext.Provider>
      </I18nProvider>,
    );
    expect(html).toContain('data-openchamber-agent-mention');
    expect(html).not.toContain('href=');
  });
});

// Guards against the agent reading an example that draws nothing, or the server sending the guidance as it was before
// GeoCode's examples: upstream's guidance.test.ts checks both, and GeoCode runs only its own tests.
describe('GeoCode: the UI block examples', () => {
  test('each draws, and the server copy is current (run ui-blocks:generate after a change)', () => {
    for (const example of UI_BLOCK_EXAMPLES) {
      expect(buildUiBlocksGuidance()).toContain(example);
      expect(parseUiBlock(example, true).kind).toBe('ready');
    }
    expect(readFileSync(UI_BLOCKS_GUIDANCE_PATH, 'utf8')).toBe(renderUiBlocksGuidanceModule(buildUiBlocksGuidance()));
  });
});
