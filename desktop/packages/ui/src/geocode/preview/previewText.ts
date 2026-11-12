import type { Locale } from '@/lib/i18n';

export type PreviewText = {
  reading: string;
  /** `shown` is the count as the locale writes it. */
  features: (count: number, shown: string) => string;
  fields: (count: number) => string;
  bands: (count: number) => string;
  shown: (bands: string) => string;
  layer: string;
  /** What a layer's features are drawn as, each a name to show or hide them by. */
  forms: { points: string; lines: string; polygons: string };
  noCrs: string;
  attributes: string;
  close: string;
  noAttributes: string;
  /** Some of the map's tiles failed; the rest is drawn. */
  partly: string;
  /** Why nothing is shown, by the reader's code for it; `other` words a code this list does not have. */
  unshown: Record<string, string> & { other: string };
};

const TEXT: { en: PreviewText } & Partial<Record<Locale, PreviewText>> = {
  en: {
    reading: 'Reading…',
    features: (count, shown) => (count === 1 ? '1 feature' : `${shown} features`),
    fields: (count) => (count === 1 ? '1 field' : `${count} fields`),
    bands: (count) => (count === 1 ? '1 band' : `${count} bands`),
    shown: (bands) => `showing ${bands}`,
    layer: 'Layer',
    forms: { points: 'Points', lines: 'Lines', polygons: 'Polygons' },
    noCrs: 'No coordinate system',
    attributes: 'Attributes',
    close: 'Close',
    noAttributes: 'This feature has no attributes.',
    partly: 'Part of the map could not be read.',
    unshown: {
      missing: 'The file is no longer there.',
      unopenable: 'This file could not be read as geographic data.',
      subdatasets: 'This file holds several datasets, which the preview cannot show yet.',
      'too-large': 'This layer is too large to draw.',
      'no-layer': 'The file has no such layer.',
      'no-crs': 'This data has no coordinate system, so it cannot be placed on the map.',
      'local-crs': 'This data uses a local coordinate system, so it cannot be placed on the map.',
      'no-georeference': 'This image has no georeferencing, so it cannot be placed on the map.',
      'no-geometry': 'This layer is a table without geometry.',
      empty: 'This layer has no features.',
      polar: 'This data lies beyond the latitudes the map reaches.',
      unprojectable: 'The place of this data on the map could not be worked out.',
      'not-ready': 'GeoCode’s Python environment is not ready yet.',
      unavailable: 'The preview could not reach GeoEngine.',
      'no-map': 'This computer cannot draw the map.',
      other: 'The preview failed.',
    },
  },
  'zh-CN': {
    reading: '读取中…',
    features: (_count, shown) => `${shown} 个要素`,
    fields: (count) => `${count} 个字段`,
    bands: (count) => `${count} 个波段`,
    shown: (bands) => `显示波段 ${bands}`,
    layer: '图层',
    forms: { points: '点', lines: '线', polygons: '面' },
    noCrs: '没有坐标系',
    attributes: '属性',
    close: '关闭',
    noAttributes: '这个要素没有属性。',
    partly: '地图有一部分没能读出来。',
    unshown: {
      missing: '文件已经不在了。',
      unopenable: '这个文件无法作为地理数据读取。',
      subdatasets: '这个文件里有多个数据集,暂不支持预览。',
      'too-large': '这个图层太大,无法绘制。',
      'no-layer': '文件里没有这个图层。',
      'no-crs': '这份数据没有坐标系,无法放到地图上。',
      'local-crs': '这份数据用的是本地坐标系,无法放到地图上。',
      'no-georeference': '这幅影像没有位置信息,无法放到地图上。',
      'no-geometry': '这个图层是没有几何的表。',
      empty: '这个图层没有要素。',
      polar: '这份数据在地图能显示的纬度之外。',
      unprojectable: '无法算出这份数据在地图上的位置。',
      'not-ready': 'GeoCode 的 Python 环境还没有准备好。',
      unavailable: '预览连不上 GeoEngine。',
      'no-map': '这台电脑无法绘制地图。',
      other: '预览失败了。',
    },
  },
  'zh-TW': {
    reading: '讀取中…',
    features: (_count, shown) => `${shown} 個圖徵`,
    fields: (count) => `${count} 個欄位`,
    bands: (count) => `${count} 個波段`,
    shown: (bands) => `顯示波段 ${bands}`,
    layer: '圖層',
    forms: { points: '點', lines: '線', polygons: '面' },
    noCrs: '沒有座標系統',
    attributes: '屬性',
    close: '關閉',
    noAttributes: '這個圖徵沒有屬性。',
    partly: '地圖有一部分沒能讀出來。',
    unshown: {
      missing: '檔案已經不在了。',
      unopenable: '這個檔案無法作為地理資料讀取。',
      subdatasets: '這個檔案裡有多個資料集,暫不支援預覽。',
      'too-large': '這個圖層太大,無法繪製。',
      'no-layer': '檔案裡沒有這個圖層。',
      'no-crs': '這份資料沒有座標系統,無法放到地圖上。',
      'local-crs': '這份資料用的是區域座標系統,無法放到地圖上。',
      'no-georeference': '這幅影像沒有位置資訊,無法放到地圖上。',
      'no-geometry': '這個圖層是沒有幾何的表格。',
      empty: '這個圖層沒有圖徵。',
      polar: '這份資料在地圖能顯示的緯度之外。',
      unprojectable: '無法算出這份資料在地圖上的位置。',
      'not-ready': 'GeoCode 的 Python 環境還沒有準備好。',
      unavailable: '預覽連不上 GeoEngine。',
      'no-map': '這台電腦無法繪製地圖。',
      other: '預覽失敗了。',
    },
  },
};

export const previewText = (locale: Locale): PreviewText => TEXT[locale] ?? TEXT.en;

export const unshownText = (text: PreviewText, code: string): string => text.unshown[code] ?? text.unshown.other;
