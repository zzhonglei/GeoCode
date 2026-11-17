import { tones, uiBlockLibrary } from './catalog';

/**
 * What an agent reads about UI blocks, built from the catalog so the
 * signatures it writes against are the ones the parser checks. The server
 * cannot import the catalog (`@openuidev/lang-core` stays out of the
 * published server package), so `generate-guidance.ts` writes this text into
 * `packages/web/server/lib/session-knowledge/ui-blocks-guidance.js`.
 *
 * Every session pays for this text, so it says each thing once: the child
 * lists of the layout components and the tone values are named once instead
 * of in every signature, and a component carries a description only where
 * its signature leaves the agent guessing.
 */

/** Examples the agent reads; each one must stay a valid block (guidance.test.ts). */
export const UI_BLOCK_EXAMPLES = [
  /* --- GeoCode: geographic work's own examples, a process and a result; GeoCode's below ---
  [
    'root = Stack([note, flow])',
    'note = Callout("Routers rewrite the MAC header, keep the IP header.", "info")',
    'flow = Steps([{title: "Sender", status: "done"}, {title: "Router", status: "current"}, {title: "Receiver"}], "row")',
  ].join('\n'),
  [
    'root = Stack([a])',
    'a = Card("#12 Login on Safari", [Badge("bug", "error"), Text("Broken since 2.1 on macOS."), Button("Fix now", "primary", "#12 Login on Safari"), Button("Later", "secondary", "#12 Login on Safari")])',
  ].join('\n'),
  */
  // The agent takes an example's method for the usual one, so each holds only what is not in dispute, and names no
  // region or coordinate system it could carry to another's data.
  [
    'root = Stack([a])',
    'a = Card("NDVI trend by district, 2019–2024", [flow, note])',
    'flow = Steps([{title: "Sentinel-2 L2A", status: "done", markdown: "412 scenes, 2019–2024"}, {title: "Cloud mask", status: "done", markdown: "Clouds, shadows and snow removed"}, {title: "Annual NDVI", status: "done", markdown: "Growing-season median, 10 m"}, {title: "District means", status: "current", markdown: "38 districts"}, {title: "Trend test", markdown: "Mann–Kendall and Sen\'s slope on the annual values"}], "row")',
    'note = Callout("Six annual values give the test little power: a trend that is not significant may still be real.", "info")',
  ].join('\n'),
  [
    'root = Stack([a])',
    'a = Card("Land cover, 2020", [Row([s1, s2, s3]), chart])',
    's1 = Stat("Built-up", "214 km²", "+18% since 2010")',
    's2 = Stat("Cropland", "512 km²", "-6% since 2010")',
    's3 = Stat("Forest", "398 km²", "-3% since 2010")',
    'chart = BarChart(["Cropland", "Forest", "Built-up", "Grassland", "Water"], [Series("Area", [512, 398, 214, 84, 32])], "km²", true)',
  ].join('\n'),
  // --- /GeoCode ---
];

const TONE_UNION = tones.map((tone) => `"${tone}"`).join(' | ');
// A child list such as (Text | Badge | ...)[]; the rules name what nests where.
const CHILD_LIST = /\((?:[A-Z]\w* \| )+[A-Z]\w*\)\[\]/g;

const componentLines = (): string => Object.values(uiBlockLibrary.toSpec().components)
  .map((component) => {
    const signature = component.signature.replaceAll(TONE_UNION, 'Tone').replace(CHILD_LIST, 'Item[]');
    return component.description ? `${signature}: ${component.description}` : signature;
  })
  .join('\n');

export function buildUiBlocksGuidance(): string {
  return [
    'UI blocks: a fenced openui-lang block in your reply draws native UI there; keep the explanation in Markdown around it. The fence is Markdown: a line ```openui-lang, the program, a line ```.',
    'Use one for data or structure the user would otherwise picture: values across items, comparisons, flows, trends, status. Not for a few numbers, a short list, code, or when asked for plain text. Several per reply are fine.',
    'Asking the user, by what the answer needs:',
    '- a quick clarification its options fully answer: the question tool;',
    '- a choice that sets the direction of the work (scope, approach, a trade-off): always geocode_render with ui (this language) and awaitAnswer, never the question tool, so the user can add conditions to the option they pick; the form adds a note field itself, read it in data.note;', // GeoCode: the tool's name in GeoCode
    /* GeoCode: not taught, so decisions on several items go where the question tool, which asks several questions at once, takes them
    '- decisions on several separate items, each with its own context: a block in your reply, a Card per item, a Button per option, value = the item. Choices collect until each decision has one (or the user sends early), then reach you together as your next turn, with any note the user wrote on a card.',
    */
    '',
    'Syntax: one statement per line, name = Component(args); first line root = Stack([...]). Positional args in signature order, optional ones droppable from the end. Strings "...", arrays [...], objects {key: value}. Every name must be reachable from root.',
    `Item = any component below except Tab and Series. Card holds no Card or Tabs; Row holds no Row, Tabs or Details; Tab holds no Tabs; Details holds no Card, Tabs or Details. Tone = ${TONE_UNION}.`,
    '',
    'Examples:',
    UI_BLOCK_EXAMPLES[0],
    '',
    UI_BLOCK_EXAMPLES[1],
    '',
    'Components:',
    componentLines(),
  ].join('\n');
}
