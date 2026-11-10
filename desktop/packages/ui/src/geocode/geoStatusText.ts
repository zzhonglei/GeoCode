import type { AgentStatus } from '@/lib/agentStatus';
import type { I18nKey } from '@/lib/i18n/messages/en';
import type { Locale } from '@/lib/i18n/runtime';

import type { GeoTool } from './geoTools';

/**
 * What the status over the composer says while calls of a geo tool run: dictionary entries of GeoCode's own, which
 * toGeoCodeDictionary adds to every dictionary, in English for the languages the app does not offer. A counted phrase,
 * for parallel calls, is written as upstream's statuses write theirs (lib/i18n/messages/agent-status.i18n.ts).
 */
const MESSAGES = {
  en: {
    'geocode.agentStatus.readgeodata': 'reading geospatial data',
    'geocode.agentStatus.qgisdoc': 'reading QGIS docs',
    'geocode.agentStatus.qgisrun': 'running a QGIS algorithm',
    'geocode.agentStatus.qgisrun.count': 'running {count, plural, one {# QGIS algorithm} other {# QGIS algorithms}}',
    'geocode.agentStatus.geerun': 'running an Earth Engine script',
    'geocode.agentStatus.geerun.count': 'running {count, plural, one {# Earth Engine script} other {# Earth Engine scripts}}',
    'geocode.agentStatus.osmsearch': 'searching OpenStreetMap',
    'geocode.agentStatus.osmprobe': 'checking OpenStreetMap tags',
    'geocode.agentStatus.osmget': 'downloading from OpenStreetMap',
  },
  'zh-CN': {
    'geocode.agentStatus.readgeodata': '正在读取地理数据',
    'geocode.agentStatus.qgisdoc': '正在查阅 QGIS 文档',
    'geocode.agentStatus.qgisrun': '正在运行 QGIS 算法',
    'geocode.agentStatus.qgisrun.count': '正在运行 {count, plural, other {# 个 QGIS 算法}}',
    'geocode.agentStatus.geerun': '正在运行 Earth Engine 脚本',
    'geocode.agentStatus.geerun.count': '正在运行 {count, plural, other {# 个 Earth Engine 脚本}}',
    'geocode.agentStatus.osmsearch': '正在查询 OpenStreetMap',
    'geocode.agentStatus.osmprobe': '正在查看 OpenStreetMap 标签',
    'geocode.agentStatus.osmget': '正在从 OpenStreetMap 下载数据',
  },
  'zh-TW': {
    'geocode.agentStatus.readgeodata': '正在讀取地理資料',
    'geocode.agentStatus.qgisdoc': '正在查閱 QGIS 文件',
    'geocode.agentStatus.qgisrun': '正在執行 QGIS 演算法',
    'geocode.agentStatus.qgisrun.count': '正在執行 {count, plural, other {# 個 QGIS 演算法}}',
    'geocode.agentStatus.geerun': '正在執行 Earth Engine 腳本',
    'geocode.agentStatus.geerun.count': '正在執行 {count, plural, other {# 個 Earth Engine 腳本}}',
    'geocode.agentStatus.osmsearch': '正在查詢 OpenStreetMap',
    'geocode.agentStatus.osmprobe': '正在查看 OpenStreetMap 標籤',
    'geocode.agentStatus.osmget': '正在從 OpenStreetMap 下載資料',
  },
};

type Key = keyof typeof MESSAGES.en;

// Reads, lookups and downloads are not counted: parallel reads may page through one file, upstream counts no searches
// either, and a download is one whatever it holds.
const KEYS = {
  readgeodata: ['geocode.agentStatus.readgeodata'],
  qgisdoc: ['geocode.agentStatus.qgisdoc'],
  qgisrun: ['geocode.agentStatus.qgisrun', 'geocode.agentStatus.qgisrun.count'],
  geerun: ['geocode.agentStatus.geerun', 'geocode.agentStatus.geerun.count'],
  osmsearch: ['geocode.agentStatus.osmsearch'],
  osmprobe: ['geocode.agentStatus.osmprobe'],
  osmgetobjects: ['geocode.agentStatus.osmget'],
  osmgetfeatures: ['geocode.agentStatus.osmget'],
} satisfies Record<GeoTool, readonly [Key, Key?]>;

export const geoStatusMessages = (locale: Locale): Record<Key, string> =>
  locale === 'zh-CN' || locale === 'zh-TW' ? MESSAGES[locale] : MESSAGES.en;

/** What the status says while `count` calls of a geo tool run. */
export const geoStatus = (tool: GeoTool, count: number): AgentStatus => {
  const [one, many]: readonly [Key, Key?] = KEYS[tool];
  // SAFETY: GeoCode's keys are not upstream's, so not in I18nKey, but every dictionary has them (toGeoCodeDictionary).
  const key = (name: string) => name as I18nKey;
  return count > 1 && many ? { key: key(many), count } : { key: key(one) };
};
