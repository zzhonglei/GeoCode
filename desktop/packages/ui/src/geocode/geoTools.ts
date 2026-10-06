import { z } from 'zod';

import { useI18nStore, type Locale } from '@/lib/i18n';
import type { ToolInput } from '@/lib/opencode/model';
import type { ToolDescription } from '@/lib/opencode/tools';
import type { ToolMetadata } from '@/lib/toolHelpers';

/** The permission actions of the geo tools that have a rule of their own; readgeodata asks as read. */
export const GEO_TOOL_ACTIONS = ['qgisdoc'] as const;

/** The geo tools, which the conversation shows with their own icons and titles. */
const GEO_TOOLS = ['qgisdoc', 'readgeodata'] as const;

type GeoTool = (typeof GEO_TOOLS)[number];

type GeoAction = (typeof GEO_TOOL_ACTIONS)[number];

type Texts = {
  /** Each tool's title, which is also its settings row's label. */
  titles: Record<GeoTool, string>;
  /** The permission card's summary of what the tool asks to do. */
  asks: Record<GeoAction, string>;
  allGroups: string;
  /** The title of a row of a tool's calls, while the model may go on and once it has moved on. */
  running: Record<GeoTool, string>;
  done: Record<GeoTool, string>;
  files: (count: number) => string;
};

const TEXT: { en: Texts } & Partial<Record<Locale, Texts>> = {
  en: {
    titles: { qgisdoc: 'QGIS Docs', readgeodata: 'Read Geodata' },
    asks: { qgisdoc: 'Look up QGIS algorithms' },
    allGroups: 'All groups',
    running: { qgisdoc: 'Reading QGIS Documentation', readgeodata: 'Reading Geospatial Data' },
    done: { qgisdoc: 'QGIS Documentation Read', readgeodata: 'Geospatial Data Read' },
    files: (count) => (count === 1 ? '1 file' : `${count} files`),
  },
  'zh-CN': {
    titles: { qgisdoc: 'QGIS 文档', readgeodata: '读取地理数据' },
    asks: { qgisdoc: '查阅 QGIS 算法' },
    allGroups: '全部分组',
    running: { qgisdoc: '正在阅读 QGIS 文档', readgeodata: '正在读取地理数据' },
    done: { qgisdoc: '已阅读 QGIS 文档', readgeodata: '已读取地理数据' },
    files: (count) => `${count} 个文件`,
  },
  'zh-TW': {
    titles: { qgisdoc: 'QGIS 文件', readgeodata: '讀取地理資料' },
    asks: { qgisdoc: '查閱 QGIS 演算法' },
    allGroups: '全部分組',
    running: { qgisdoc: '正在閱讀 QGIS 文件', readgeodata: '正在讀取地理資料' },
    done: { qgisdoc: '已閱讀 QGIS 文件', readgeodata: '已讀取地理資料' },
    files: (count) => `${count} 個檔案`,
  },
};

export const isGeoTool = (name: string): name is GeoTool => GEO_TOOLS.some((tool) => tool === name);

const isGeoAction = (name: string): name is GeoAction => GEO_TOOL_ACTIONS.some((action) => action === name);

// Read outside React: the callers are plain functions, and the rows rerender when the language changes.
const text = () => TEXT[useI18nStore.getState().locale] ?? TEXT.en;

/** The title a geo tool's row shows; undefined for any other tool. */
export const geoToolMetadata = (toolName: string): ToolMetadata | undefined =>
  isGeoTool(toolName)
    ? {
        displayName: text().titles[toolName],
        category: toolName === 'readgeodata' ? 'file' : 'search',
        outputLanguage: 'text',
        inputFields: [],
      }
    : undefined;

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

/** What a geo tool's row says it is doing, from its input; null when there is nothing to say. */
export const geoToolDescription = (toolName: string, input: ToolInput | undefined): ToolDescription | null | undefined => {
  if (toolName === 'readgeodata') {
    const value = dataset(input);
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
export const geoRunTitle = (toolName: GeoTool, running: boolean) => (running ? text().running : text().done)[toolName];

/** How many files a row of readgeodata calls read. */
export const geoFileCount = (count: number) => text().files(count);

/** The permission card's summary for a geo tool's own action; undefined for any other action. */
export const geoPermissionTitle = (action: string): string | undefined => (isGeoAction(action) ? text().asks[action] : undefined);

/** The settings label of a geo tool's permission rule; undefined for any other key. */
export const geoActionLabel = (key: string): string | undefined => (isGeoAction(key) ? text().titles[key] : undefined);
