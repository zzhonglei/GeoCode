import { z } from 'zod';

import type { ChatMessageEntry } from '@/components/chat/lib/turns/types';
import { useI18nStore, type Locale } from '@/lib/i18n';
import type { ToolInput } from '@/lib/opencode/model';
import type { PermissionRequest } from '@/types/permission';

import { osmText } from './osmText';

/** The permission actions of the geo tools that have a rule of their own; readgeodata asks as read. */
export const GEO_TOOL_ACTIONS = [
  'qgisdoc',
  'qgisrun',
  'geerun',
  'osmsearch',
  'osmprobe',
  'osmgetobjects',
  'osmgetfeatures',
] as const satisfies readonly GeoTool[];

/** The kernel's geo tools, which the conversation shows with their own icons and titles. */
export const GEO_TOOLS = [
  'qgisdoc',
  'readgeodata',
  'qgisrun',
  'geerun',
  'osmsearch',
  'osmprobe',
  'osmgetobjects',
  'osmgetfeatures',
] as const;

export type GeoTool = (typeof GEO_TOOLS)[number];

type GeoAction = (typeof GEO_TOOL_ACTIONS)[number];

/** The tools whose calls show as rows of their own merged ones. */
type MergedTool = 'qgisdoc' | 'readgeodata';

type Texts = {
  /** The title of each tool with a rule of its own, which is also its settings row's label. */
  titles: Record<GeoAction, string>;
  /** The permission card's summary of what the tool asks to do. */
  asks: Record<GeoAction, string>;
  allGroups: string;
  /** The title of a row of a tool's calls, while the model may go on and once it has moved on. */
  running: Record<MergedTool, string>;
  done: Record<MergedTool, string>;
  files: (count: number) => string;
  /** Beside a row's title, how many of its calls failed. */
  failed: (count: number) => string;
  /** qgisrun's row while it runs, naming the algorithm. */
  runs: (algorithm: string) => string;
  /** The lines the geo tools' own permission cards share. */
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
  /** What a settled turn's folded activity says the geo tools did, beside what it says of upstream's. */
  activity: {
    read: string;
    docs: string;
    qgis: (count: number) => string;
    gee: (count: number) => string;
    /** A search or a look. */
    searched: string;
    downloaded: string;
  };
  /** Earth Engine runs in the background, beside the background commands. */
  background: {
    /** A session's mark in the session list, while its run goes on. */
    running: string;
    /** The strip over the composer, folded. */
    count: (count: number) => string;
    /** The strip's name, for a screen reader. */
    strip: string;
    stop: string;
    stopAll: string;
    /** A row's stop, for a screen reader. */
    stopAria: (description: string) => string;
    stopFailed: string;
  };
};

/** The OSM tools' titles and askings, kept with their other texts. */
const osmActions = (locale: Locale) => {
  const words = osmText(locale);
  return {
    titles: {
      osmsearch: words.search,
      osmprobe: words.probe,
      osmgetobjects: words.downloadObjects,
      osmgetfeatures: words.downloadFeatures,
    },
    asks: words.asks,
  };
};

const TEXT: { en: Texts } & Partial<Record<Locale, Texts>> = {
  en: {
    titles: {
      qgisdoc: 'QGIS Docs',
      qgisrun: 'Run QGIS Algorithm',
      geerun: 'Run Earth Engine Script',
      ...osmActions('en').titles,
    },
    asks: {
      qgisdoc: 'Look up QGIS algorithms',
      qgisrun: 'Request to run QGIS algorithm',
      geerun: 'Request to run Earth Engine script',
      ...osmActions('en').asks,
    },
    allGroups: 'All groups',
    running: { qgisdoc: 'Reading QGIS Documentation', readgeodata: 'Reading Geospatial Data' },
    done: { qgisdoc: 'QGIS Documentation Read', readgeodata: 'Geospatial Data Read' },
    files: (count) => (count === 1 ? '1 file' : `${count} files`),
    failed: (count) => `${count} failed`,
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
    activity: {
      read: 'Read geospatial data',
      docs: 'Read QGIS docs',
      qgis: (count) => (count === 1 ? 'Ran 1 QGIS algorithm' : `Ran ${count} QGIS algorithms`),
      gee: (count) => (count === 1 ? 'Ran 1 Earth Engine script' : `Ran ${count} Earth Engine scripts`),
      searched: 'Searched OpenStreetMap',
      downloaded: 'Downloaded from OpenStreetMap',
    },
    background: {
      running: 'Earth Engine script running in the background',
      count: (count) => `Background Earth Engine scripts: ${count}`,
      strip: 'Background Earth Engine scripts',
      stop: 'Stop',
      stopAll: 'Stop all',
      stopAria: (description) => `Stop ${description}`,
      stopFailed: 'Could not stop the Earth Engine run',
    },
  },
  'zh-CN': {
    titles: {
      qgisdoc: 'QGIS 文档',
      qgisrun: '运行 QGIS 算法',
      geerun: '运行 Earth Engine 脚本',
      ...osmActions('zh-CN').titles,
    },
    asks: {
      qgisdoc: '查阅 QGIS 算法',
      qgisrun: '请求执行 QGIS 算法',
      geerun: '请求执行 Earth Engine 脚本',
      ...osmActions('zh-CN').asks,
    },
    allGroups: '全部分组',
    running: { qgisdoc: '正在阅读 QGIS 文档', readgeodata: '正在读取地理数据' },
    done: { qgisdoc: '已阅读 QGIS 文档', readgeodata: '已读取地理数据' },
    files: (count) => `${count} 个文件`,
    failed: (count) => `${count} 个失败`,
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
    activity: {
      read: '读取了地理数据',
      docs: '查阅了 QGIS 文档',
      qgis: (count) => `运行了 ${count} 个 QGIS 算法`,
      gee: (count) => `运行了 ${count} 个 Earth Engine 脚本`,
      searched: '查询了 OpenStreetMap',
      downloaded: '从 OpenStreetMap 下载了数据',
    },
    background: {
      running: 'Earth Engine 脚本正在后台运行',
      count: (count) => `后台 Earth Engine 脚本：${count}`,
      strip: '后台 Earth Engine 脚本',
      stop: '停止',
      stopAll: '全部停止',
      stopAria: (description) => `停止 ${description}`,
      stopFailed: '未能停止 Earth Engine 运行',
    },
  },
  'zh-TW': {
    titles: {
      qgisdoc: 'QGIS 文件',
      qgisrun: '執行 QGIS 演算法',
      geerun: '執行 Earth Engine 腳本',
      ...osmActions('zh-TW').titles,
    },
    asks: {
      qgisdoc: '查閱 QGIS 演算法',
      qgisrun: '請求執行 QGIS 演算法',
      geerun: '請求執行 Earth Engine 腳本',
      ...osmActions('zh-TW').asks,
    },
    allGroups: '全部分組',
    running: { qgisdoc: '正在閱讀 QGIS 文件', readgeodata: '正在讀取地理資料' },
    done: { qgisdoc: '已閱讀 QGIS 文件', readgeodata: '已讀取地理資料' },
    files: (count) => `${count} 個檔案`,
    failed: (count) => `${count} 個失敗`,
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
    activity: {
      read: '讀取了地理資料',
      docs: '查閱了 QGIS 文件',
      qgis: (count) => `執行了 ${count} 個 QGIS 演算法`,
      gee: (count) => `執行了 ${count} 個 Earth Engine 腳本`,
      searched: '查詢了 OpenStreetMap',
      downloaded: '從 OpenStreetMap 下載了資料',
    },
    background: {
      running: 'Earth Engine 腳本正在背景執行',
      count: (count) => `背景 Earth Engine 腳本：${count}`,
      strip: '背景 Earth Engine 腳本',
      stop: '停止',
      stopAll: '全部停止',
      stopAria: (description) => `停止 ${description}`,
      stopFailed: '無法停止 Earth Engine 執行',
    },
  },
};

export const isGeoTool = (name: string): name is GeoTool => GEO_TOOLS.some((tool) => tool === name);

const isGeoAction = (name: string): name is GeoAction => GEO_TOOL_ACTIONS.some((action) => action === name);

const textIn = (locale: Locale) => TEXT[locale] ?? TEXT.en;

// Read outside React: the callers are plain functions, and the rows rerender when the language changes.
const text = () => textIn(useI18nStore.getState().locale);

const filled = z.string().trim().min(1).optional().catch(undefined);
const qgisdocInput = z.object({ action: z.string().optional().catch(undefined), algorithm: filled, group: filled, query: filled });
const readgeodataInput = z.object({ path: filled, layer: filled });

/** The path a readgeodata call reads, as GeoAgent gave it. */
export const geoDataPath = (input: ToolInput | undefined) => readgeodataInput.safeParse(input).data?.path;

/** The file a readgeodata call reads, with the layer it names; the name only, as the read rows show files. */
const dataset = (input: ToolInput | undefined) => {
  const parsed = readgeodataInput.safeParse(input);
  const file = parsed.data?.path?.split(/[\\/]/).filter(Boolean).at(-1);
  if (!file) return undefined;
  return parsed.data?.layer ? `${file} · ${parsed.data.layer}` : file;
};

/** What a merged row's call is reading or looking up, from its input; undefined when there is nothing to say. */
export const geoToolDescription = (toolName: string, input: ToolInput | undefined) => {
  if (toolName === 'readgeodata') return dataset(input);
  const parsed = qgisdocInput.safeParse(input);
  if (!parsed.success) return undefined;
  const { action, algorithm, group, query } = parsed.data;
  // Each action's own field, as the kernel asks permission for it.
  const values = new Map([['groups', text().allGroups], ['algorithms', group], ['help', algorithm], ['search', query]]);
  return action ? values.get(action) : undefined;
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

/** The labels and warnings the geo tools' own permission cards share. */
export const geoCardText = (locale: Locale) => textIn(locale).card;

/** How many lines of a script geerun's card shows, blank ones aside; scripts run long, so the rest is only counted. */
const EXCERPT_LINES = 4;

/** A script's first lines, from its first that is not blank, and how many lines follow them. */
export const excerptOf = (script: string) => {
  const lines = script.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd().split(/\r?\n/);
  const ends = lines.flatMap((line, index) => (line.trim() ? [index + 1] : []));
  const end = ends[EXCERPT_LINES - 1] ?? lines.length;
  return { shown: lines.slice(0, end).join('\n'), rest: lines.length - end };
};

/**
 * What a settled turn's folded activity says its finished geo calls did, a phrase each kind; runs are counted, as the
 * status over the composer counts them.
 */
export const geoActivity = (messages: readonly ChatMessageEntry[], locale: Locale): string[] => {
  const finished = new Map<string, number>();
  const seen = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool' || part.state.status !== 'completed') continue;
      // A refused qgisrun ran nothing. Read here, not with qgisRun.ts, which imports this file.
      if (part.tool === 'qgisrun' && part.state.metadata?.outcome === 'refused') continue;
      // Each call once, keyed as upstream's summary keys it.
      const key = `${message.info.id}:${part.callID || part.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      finished.set(part.tool, (finished.get(part.tool) ?? 0) + 1);
    }
  }
  const count = (tool: GeoTool) => finished.get(tool) ?? 0;
  const words = textIn(locale).activity;
  return [
    count('readgeodata') ? words.read : undefined,
    count('qgisdoc') ? words.docs : undefined,
    count('qgisrun') ? words.qgis(count('qgisrun')) : undefined,
    count('geerun') ? words.gee(count('geerun')) : undefined,
    count('osmsearch') || count('osmprobe') ? words.searched : undefined,
    count('osmgetobjects') || count('osmgetfeatures') ? words.downloaded : undefined,
  ].filter((phrase) => phrase !== undefined);
};

/** How many files a row of readgeodata calls read. */
export const geoFileCount = (count: number, locale: Locale) => textIn(locale).files(count);

export const geoFailedCount = (count: number, locale: Locale) => textIn(locale).failed(count);

/** The permission card's summary for a geo tool's own action; undefined for any other action. */
export const geoPermissionTitle = (action: string): string | undefined => (isGeoAction(action) ? text().asks[action] : undefined);

const askingAlgorithm = z.object({ algorithm: qgisAlgorithm.optional().catch(undefined) });

/**
 * The name a permission request shows beside its tool's icon: qgisrun's asks to run the algorithm it names, qgisdoc's is
 * the tool's title, the other geo tools' say what they ask to do.
 */
export const geoPermissionName = (permission: PermissionRequest, locale: Locale): string => {
  const words = textIn(locale);
  if (permission.action === 'qgisdoc') return words.titles.qgisdoc;
  if (permission.action !== 'qgisrun') {
    return isGeoAction(permission.action) ? words.asks[permission.action] : permission.action;
  }
  const algorithm = askingAlgorithm.safeParse(permission.metadata ?? {}).data?.algorithm;
  return algorithm ? `${words.asks.qgisrun} ${qgisAlgorithmText(algorithm, locale).name}` : words.asks.qgisrun;
};

/**
 * What "always allow" names for a geo tool's own saves; undefined for any other action. Nothing for qgisrun, whose
 * card names the algorithm and the directories, never their ids and globs; the directory an OSM download writes in
 * outside the project, without its glob.
 */
export const geoSavePatterns = (action: string, save: readonly string[]): string[] | undefined => {
  if (action === 'qgisrun') return [];
  if (action !== 'osmgetobjects' && action !== 'osmgetfeatures') return undefined;
  return save.map((pattern) => (pattern === '/*' ? pattern : pattern.replace(/\/\*$/, '')));
};

const IN_APP: ReadonlySet<string> = new Set(['qgisrun', 'geerun', 'osmgetobjects', 'osmgetfeatures']);

/**
 * A run or a download is approved on its card, which shows what it will do, where it writes and its warnings; the tray
 * can only deny it or open it.
 */
export const reviewInApp = (action: string) => IN_APP.has(action);

/**
 * The tray's label for a geo tool's request, in English like the rest of the tray; a run shows no algorithm id, nor a
 * download its folder.
 */
export const geoTrayLabel = (action: string, resources: readonly string[]): string | undefined => {
  if (!isGeoAction(action)) return undefined;
  const title = TEXT.en.titles[action];
  const resource = reviewInApp(action) ? undefined : resources.find((value) => value.trim());
  return resource ? `${title}: ${resource}` : title;
};

// In English like the status's other phrases. Reads, lookups and downloads are not counted: parallel reads may page
// through one file, upstream counts no searches either, and a download is one whatever it holds.
const STATUS = {
  readgeodata: () => 'reading geospatial data',
  qgisdoc: () => 'reading QGIS docs',
  qgisrun: (count) => (count === 1 ? 'running a QGIS algorithm' : `running ${count} QGIS algorithms`),
  geerun: (count) => (count === 1 ? 'running an Earth Engine script' : `running ${count} Earth Engine scripts`),
  osmsearch: () => 'searching OpenStreetMap',
  osmprobe: () => 'checking OpenStreetMap tags',
  osmgetobjects: () => 'downloading from OpenStreetMap',
  osmgetfeatures: () => 'downloading from OpenStreetMap',
} satisfies Record<GeoTool, (count: number) => string>;

/** What the status over the composer says while `count` calls of a geo tool run. */
export const geoStatusPhrase = (tool: GeoTool, count: number) => STATUS[tool](count);
