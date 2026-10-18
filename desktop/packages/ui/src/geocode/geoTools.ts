import { z } from 'zod';

import { useI18nStore, type Locale } from '@/lib/i18n';
import type { ToolInput } from '@/lib/opencode/model';
import type { ToolDescription } from '@/lib/opencode/tools';
import type { ToolMetadata } from '@/lib/toolHelpers';
import type { PermissionRequest } from '@/types/permission';

/** The permission actions of the geo tools that have a rule of their own; readgeodata asks as read. */
export const GEO_TOOL_ACTIONS = ['qgisdoc', 'qgisrun', 'geerun'] as const;

/** The geo tools, which the conversation shows with their own icons and titles. */
const GEO_TOOLS = ['qgisdoc', 'readgeodata', 'qgisrun', 'geerun'] as const;

type GeoTool = (typeof GEO_TOOLS)[number];

type GeoAction = (typeof GEO_TOOL_ACTIONS)[number];

/** The tools whose calls show as rows of their own merged ones. */
type MergedTool = Exclude<GeoTool, 'qgisrun' | 'geerun'>;

type Texts = {
  /** Each tool's title, which is also its settings row's label. */
  titles: Record<GeoTool | GeoAction, string>;
  /** The permission card's summary of what the tool asks to do. */
  asks: Record<GeoAction, string>;
  allGroups: string;
  /** The title of a row of a tool's calls, while the model may go on and once it has moved on. */
  running: Record<MergedTool, string>;
  done: Record<MergedTool, string>;
  files: (count: number) => string;
  /** qgisrun's row while it runs, naming the algorithm. */
  runs: (algorithm: string) => string;
  /** The lines of qgisrun's and geerun's permission cards. */
  card: {
    /** What follows a label on the card's first lines. */
    colon: string;
    reason: string;
    purpose: string;
    outside: (directory: string) => string;
    /** An output that is no file, such as a database. */
    elsewhere: (target: string) => string;
    guarded: string;
    input: string;
    parameters: string;
    output: string;
    file: string;
    /** Under a script's first lines, what is left out. */
    rest: (count: number) => string;
  };
  /** Earth Engine runs in the background, beside the background commands. */
  background: {
    /** A session's mark in the session list, while its run goes on. */
    running: string;
    /** The strip over the composer, folded. */
    count: (count: number) => string;
    /** The strip's name, for a screen reader. */
    strip: string;
  };
};

const TEXT: { en: Texts } & Partial<Record<Locale, Texts>> = {
  en: {
    titles: { qgisdoc: 'QGIS Docs', readgeodata: 'Read Geodata', qgisrun: 'Run QGIS Algorithm', geerun: 'Run Earth Engine Script' },
    asks: { qgisdoc: 'Look up QGIS algorithms', qgisrun: 'Request to run QGIS algorithm', geerun: 'Request to run Earth Engine script' },
    allGroups: 'All groups',
    running: { qgisdoc: 'Reading QGIS Documentation', readgeodata: 'Reading Geospatial Data' },
    done: { qgisdoc: 'QGIS Documentation Read', readgeodata: 'Geospatial Data Read' },
    files: (count) => (count === 1 ? '1 file' : `${count} files`),
    runs: (algorithm) => `Running ${algorithm}`,
    card: {
      colon: ': ',
      reason: 'Reason',
      purpose: 'Purpose',
      outside: (directory) => `Writes files in ${directory}, outside the project.`,
      elsewhere: (target) => `Writes to a database or another place that is not a file: ${target}`,
      guarded: 'This algorithm may change or affect your existing data.',
      input: 'Input',
      parameters: 'Parameters',
      output: 'Output',
      file: 'Script file',
      rest: (count) => `… ${count} more ${count === 1 ? 'line' : 'lines'}`,
    },
    background: {
      running: 'Earth Engine script running in the background',
      count: (count) => `Background Earth Engine scripts: ${count}`,
      strip: 'Background Earth Engine scripts',
    },
  },
  'zh-CN': {
    titles: { qgisdoc: 'QGIS 文档', readgeodata: '读取地理数据', qgisrun: '运行 QGIS 算法', geerun: '运行 Earth Engine 脚本' },
    asks: { qgisdoc: '查阅 QGIS 算法', qgisrun: '请求执行 QGIS 算法', geerun: '请求执行 Earth Engine 脚本' },
    allGroups: '全部分组',
    running: { qgisdoc: '正在阅读 QGIS 文档', readgeodata: '正在读取地理数据' },
    done: { qgisdoc: '已阅读 QGIS 文档', readgeodata: '已读取地理数据' },
    files: (count) => `${count} 个文件`,
    runs: (algorithm) => `正在执行${algorithm}`,
    card: {
      colon: '：',
      reason: '请求原因',
      purpose: '算法用途',
      outside: (directory) => `将在项目外的 ${directory} 中写入文件。`,
      elsewhere: (target) => `将写入数据库或其他非文件位置：${target}`,
      guarded: '此算法可能会修改或影响你现有的数据。',
      input: '输入',
      parameters: '参数',
      output: '输出',
      file: '脚本文件',
      rest: (count) => `…… 其余 ${count} 行`,
    },
    background: {
      running: 'Earth Engine 脚本正在后台运行',
      count: (count) => `后台 Earth Engine 脚本：${count}`,
      strip: '后台 Earth Engine 脚本',
    },
  },
  'zh-TW': {
    titles: { qgisdoc: 'QGIS 文件', readgeodata: '讀取地理資料', qgisrun: '執行 QGIS 演算法', geerun: '執行 Earth Engine 腳本' },
    asks: { qgisdoc: '查閱 QGIS 演算法', qgisrun: '請求執行 QGIS 演算法', geerun: '請求執行 Earth Engine 腳本' },
    allGroups: '全部分組',
    running: { qgisdoc: '正在閱讀 QGIS 文件', readgeodata: '正在讀取地理資料' },
    done: { qgisdoc: '已閱讀 QGIS 文件', readgeodata: '已讀取地理資料' },
    files: (count) => `${count} 個檔案`,
    runs: (algorithm) => `正在執行${algorithm}`,
    card: {
      colon: '：',
      reason: '請求原因',
      purpose: '演算法用途',
      outside: (directory) => `將在專案外的 ${directory} 中寫入檔案。`,
      elsewhere: (target) => `將寫入資料庫或其他非檔案位置：${target}`,
      guarded: '此演算法可能會修改或影響你現有的資料。',
      input: '輸入',
      parameters: '參數',
      output: '輸出',
      file: '腳本檔案',
      rest: (count) => `…… 其餘 ${count} 行`,
    },
    background: {
      running: 'Earth Engine 腳本正在背景執行',
      count: (count) => `背景 Earth Engine 腳本：${count}`,
      strip: '背景 Earth Engine 腳本',
    },
  },
};

export const isGeoTool = (name: string): name is GeoTool => GEO_TOOLS.some((tool) => tool === name);

const isGeoAction = (name: string): name is GeoAction => GEO_TOOL_ACTIONS.some((action) => action === name);

const textIn = (locale: Locale) => TEXT[locale] ?? TEXT.en;

// Read outside React: the callers are plain functions, and the rows rerender when the language changes.
const text = () => textIn(useI18nStore.getState().locale);

/** The title a geo tool's row shows; undefined for any other tool. */
export const geoToolMetadata = (toolName: string): ToolMetadata | undefined =>
  isGeoTool(toolName)
    ? {
        displayName: text().titles[toolName],
        category: toolName === 'readgeodata' ? 'file' : toolName === 'qgisdoc' ? 'search' : 'system',
        outputLanguage: 'text',
        inputFields: [],
      }
    : undefined;

const filled = z.string().trim().min(1).optional().catch(undefined);
const qgisdocInput = z.object({ action: z.string().optional().catch(undefined), algorithm: filled, group: filled, query: filled });
const readgeodataInput = z.object({ path: filled, layer: filled });
const runInput = z.object({ description: filled });

/** The path a readgeodata call reads, as GeoAgent gave it. */
export const geoDataPath = (input: ToolInput | undefined) => readgeodataInput.safeParse(input).data?.path;

/** The file a readgeodata call reads, with the layer it names; the name only, as the read rows show files. */
const dataset = (input: ToolInput | undefined) => {
  const parsed = readgeodataInput.safeParse(input);
  const file = parsed.data?.path?.split(/[\\/]/).filter(Boolean).at(-1);
  if (!file) return undefined;
  return parsed.data?.layer ? `${file} · ${parsed.data.layer}` : file;
};

/** What a geo tool's row says it is doing, from its input; null when there is nothing to say. */
export const geoToolDescription = (toolName: string, input: ToolInput | undefined): ToolDescription | null | undefined => {
  if (toolName === 'readgeodata') {
    const value = dataset(input);
    return value ? { kind: 'text', value } : null;
  }
  if (toolName === 'qgisrun' || toolName === 'geerun') {
    const value = runInput.safeParse(input).data?.description;
    return value ? { kind: 'text', value } : null;
  }
  if (toolName !== 'qgisdoc') return undefined;
  const parsed = qgisdocInput.safeParse(input);
  if (!parsed.success) return null;
  const { action, algorithm, group, query } = parsed.data;
  // Each action's own field, as the kernel asks permission for it.
  const values = new Map([['groups', text().allGroups], ['algorithms', group], ['help', algorithm], ['search', query]]);
  const value = action ? values.get(action) : undefined;
  return value ? { kind: 'text', value } : null;
};

const webfetchInput = z.object({ url: z.url({ protocol: /^https$/, hostname: /^docs\.qgis\.org$/ }) });

/** The page of the QGIS manual a webfetch call read; undefined for any other call. */
export const qgisManualUrl = (toolName: string, input: ToolInput | undefined): string | undefined =>
  toolName === 'webfetch' ? webfetchInput.safeParse(input).data?.url : undefined;

/** The title of a row of a geo tool's calls. */
export const geoRunTitle = (toolName: MergedTool, running: boolean) => (running ? text().running : text().done)[toolName];

const translated = z.object({ name: z.string(), description: z.string() });

/** The algorithm a qgisrun call runs, as the kernel describes it; QGIS's own translations by the interface's language. */
export const qgisAlgorithm = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  translations: z.record(z.string(), translated).catch({}),
});

type QgisAlgorithm = z.infer<typeof qgisAlgorithm>;

// qgisrun's texts take the language from their callers, which the React Compiler then caches them by.

/** An algorithm's name and description in the interface's language, as the user's own QGIS shows them. */
export const qgisAlgorithmText = (algorithm: QgisAlgorithm, locale: Locale): z.infer<typeof translated> =>
  algorithm.translations[locale] ?? { name: algorithm.name, description: algorithm.description };

/** qgisrun's title, for a row whose call GeoAgent did not label. */
export const qgisRunTitle = (locale: Locale) => textIn(locale).titles.qgisrun;

/** geerun's title, for a row whose call GeoAgent did not label. */
export const geeRunTitle = (locale: Locale) => textIn(locale).titles.geerun;

/** What tells of Earth Engine runs in the background. */
export const geeBackgroundText = (locale: Locale) => textIn(locale).background;

/** What qgisrun's row says while the algorithm runs. */
export const qgisRunning = (algorithm: string, locale: Locale) => textIn(locale).runs(algorithm);

/** The labels and warnings of qgisrun's and geerun's permission cards. */
export const geoCardText = (locale: Locale) => textIn(locale).card;

/** How many of a script's lines geerun's card shows; scripts run long, so the rest is only counted. */
const EXCERPT_LINES = 4;

/** A script's first lines, past any blank ones, and how many lines follow them. */
export const excerptOf = (script: string) => {
  const lines = script.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd().split(/\r?\n/);
  return { shown: lines.slice(0, EXCERPT_LINES).join('\n'), rest: Math.max(0, lines.length - EXCERPT_LINES) };
};

/** How many files a row of readgeodata calls read. */
export const geoFileCount = (count: number) => text().files(count);

/** The permission card's summary for a geo tool's own action; undefined for any other action. */
export const geoPermissionTitle = (action: string): string | undefined => (isGeoAction(action) ? text().asks[action] : undefined);

const askingAlgorithm = z.object({ algorithm: qgisAlgorithm.optional().catch(undefined) });

/**
 * The name a permission request shows beside its tool's icon: qgisrun's asks to run the algorithm it names, geerun's to
 * run a script.
 */
export const geoPermissionName = (permission: PermissionRequest): string => {
  if (permission.action === 'geerun') return text().asks.geerun;
  if (permission.action !== 'qgisrun') return permission.action;
  const algorithm = askingAlgorithm.safeParse(permission.metadata ?? {}).data?.algorithm;
  const locale = useI18nStore.getState().locale;
  return algorithm ? `${text().asks.qgisrun} ${qgisAlgorithmText(algorithm, locale).name}` : text().asks.qgisrun;
};

/** The settings label of a geo tool's permission rule; undefined for any other key. */
export const geoActionLabel = (key: string): string | undefined => (isGeoAction(key) ? text().titles[key] : undefined);

/** A run is approved on its card, which shows what it will do and its warnings; the tray can only deny it or open it. */
export const reviewInApp = (action: string) => action === 'qgisrun' || action === 'geerun';

/** The tray's label for a geo tool's request, in English like the rest of the tray; a run shows no algorithm id. */
export const geoTrayLabel = (action: string, resources: readonly string[]): string | undefined => {
  if (!isGeoAction(action)) return undefined;
  const title = TEXT.en.titles[action];
  const resource = reviewInApp(action) ? undefined : resources.find((value) => value.trim());
  return resource ? `${title}: ${resource}` : title;
};
