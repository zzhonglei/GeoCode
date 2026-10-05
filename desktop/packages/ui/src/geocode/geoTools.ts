import { z } from 'zod';

import { useI18nStore, type Locale } from '@/lib/i18n';
import type { ToolInput } from '@/lib/opencode/model';
import type { ToolDescription } from '@/lib/opencode/tools';
import type { ToolMetadata } from '@/lib/toolHelpers';

/** The permission actions of the geo tools that have a rule of their own. */
export const GEO_TOOL_ACTIONS = ['qgisdoc'] as const;

type GeoTool = (typeof GEO_TOOL_ACTIONS)[number];

type GeoToolText = {
  /** The tool row's title and the settings row's label. */
  title: string;
  /** The permission card's summary of what the tool asks to do. */
  asks: string;
};

type Texts = Record<GeoTool, GeoToolText> & {
  allGroups: string;
  /** The title of a row of qgisdoc calls, while the model may still read on and once it has moved on. */
  reading: string;
  read: string;
};

const TEXT: { en: Texts } & Partial<Record<Locale, Texts>> = {
  en: {
    qgisdoc: { title: 'QGIS Docs', asks: 'Look up QGIS algorithms' },
    allGroups: 'All groups',
    reading: 'Reading QGIS Documentation',
    read: 'QGIS Documentation Read',
  },
  'zh-CN': {
    qgisdoc: { title: 'QGIS 文档', asks: '查阅 QGIS 算法' },
    allGroups: '全部分组',
    reading: '正在阅读 QGIS 文档',
    read: '已阅读 QGIS 文档',
  },
  'zh-TW': {
    qgisdoc: { title: 'QGIS 文件', asks: '查閱 QGIS 演算法' },
    allGroups: '全部分組',
    reading: '正在閱讀 QGIS 文件',
    read: '已閱讀 QGIS 文件',
  },
};

export const isGeoTool = (name: string): name is GeoTool => GEO_TOOL_ACTIONS.some((action) => action === name);

// Read outside React: the callers are plain functions, and the rows rerender when the language changes.
const text = () => TEXT[useI18nStore.getState().locale] ?? TEXT.en;

/** The title a geo tool's row shows; undefined for any other tool. */
export const geoToolMetadata = (toolName: string): ToolMetadata | undefined =>
  isGeoTool(toolName)
    ? { displayName: text()[toolName].title, category: 'search', outputLanguage: 'text', inputFields: [] }
    : undefined;

const filled = z.string().trim().min(1).optional().catch(undefined);
const qgisdocInput = z.object({ action: z.string().optional().catch(undefined), algorithm: filled, group: filled, query: filled });

/** What a geo tool's row says it is doing, from its input; null when there is nothing to say. */
export const geoToolDescription = (toolName: string, input: ToolInput | undefined): ToolDescription | null | undefined => {
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

/** The title of a row of qgisdoc calls. */
export const qgisDocRunTitle = (reading: boolean) => (reading ? text().reading : text().read);

/** The permission card's summary for a geo tool's own action; undefined for any other action. */
export const geoPermissionTitle = (action: string): string | undefined => (isGeoTool(action) ? text()[action].asks : undefined);

/** The settings label of a geo tool's permission rule; undefined for any other key. */
export const geoActionLabel = (key: string): string | undefined => (isGeoTool(key) ? text()[key].title : undefined);
