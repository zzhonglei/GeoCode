import type { Locale } from '@/lib/i18n';

export type PreviewText = {
  reading: string;
  /** `shown` is the count as the locale writes it. */
  features: (count: number, shown: string) => string;
  bands: (count: number) => string;
  shown: (bands: string) => string;
  layer: string;
  /** What a layer's features are drawn as, each a name to show or hide them by. */
  forms: { points: string; lines: string; polygons: string };
  noCrs: string;
  close: string;
  noAttributes: string;
  zoomIn: string;
  zoomOut: string;
  /** Back to where the whole of the data shows. */
  whole: string;
  /** The panel beside the map: what its tabs are called, and what opens and closes it. */
  tabs: { feature: string; table: string; look: string; pixel: string; info: string };
  /** Shown where a clicked pixel's values go, before any is clicked. */
  pixelHint: string;
  /** What is said of a pixel: where it is in the raster's grid, and of a band without data there. */
  pixel: { column: string; row: string; noData: string };
  /** What one band is coloured by: its classes, or a ramp by the reader's name for it; a ramp this has no word for goes by that name. */
  ramps: Record<string, string>;
  /**
   * What a band's values are drawn between: all but the 2% at each end, all, two deviations about the mean, as they
   * are, or as the lines were dragged. The 2% is the reader's, CUT in geoengine/python/geocodekit/preview/_raster.py.
   */
  stretches: { cut: string; minmax: string; deviation: string; none: string; custom: string };
  ramp: string;
  stretch: string;
  /** How a raster of several bands is drawn: three of them as red, green and blue, or one alone. */
  mode: string;
  modes: { composite: string; single: string };
  band: string;
  /** What the columns of the table of bands are headed: the values that leave out 2% at each end, and the mean. */
  columns: { low: string; high: string; mean: string };
  /** What the button says that draws a band as red, green or blue. */
  bandAs: (band: number, channel: 0 | 1 | 2) => string;
  measures: { min: string; max: string; mean: string; std: string };
  /** Said of what is measured: it is of a sample of the raster, not of every pixel. */
  sampled: string;
  openPanel: string;
  closePanel: string;
  /** Shown where a clicked feature's attributes go, before any is clicked. */
  pickHint: string;
  /** Which of the layer's features this one is; both are counts as the locale writes them. */
  nth: (position: string, total: string) => string;
  /** The rows a page of the table holds; all three are counts as the locale writes them. */
  rows: (first: string, last: string, total: string) => string;
  /** Moves the map to where the picked feature is. */
  reach: string;
  previousPage: string;
  nextPage: string;
  /** What the rows of the info tab are called. */
  info: { layer: string; geometry: string; features: string; fields: string; crs: string; extent: string; size: string; bands: string; nodata: string };
  /** Some of the map's tiles failed; the rest is drawn. */
  partly: string;
  /** Why nothing is shown, by the reader's code for it; `other` words a code this list does not have. */
  unshown: Record<string, string> & { other: string };
};

const TEXT: { en: PreviewText } & Partial<Record<Locale, PreviewText>> = {
  en: {
    reading: 'Reading…',
    features: (count, shown) => (count === 1 ? '1 feature' : `${shown} features`),
    bands: (count) => (count === 1 ? '1 band' : `${count} bands`),
    shown: (bands) => `showing ${bands}`,
    layer: 'Layer',
    forms: { points: 'Points', lines: 'Lines', polygons: 'Polygons' },
    noCrs: 'No coordinate system',
    close: 'Close',
    noAttributes: 'This feature has no attributes.',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    whole: 'Show all of it',
    tabs: { feature: 'Feature', table: 'Table', look: 'Display', pixel: 'Pixel', info: 'Info' },
    pixelHint: 'Click the raster on the map to see the values of the pixel there.',
    pixel: { column: 'Column', row: 'Row', noData: 'no data' },
    ramps: { classes: 'Classes', grey: 'Greyscale', terrain: 'Terrain', viridis: 'Viridis', magma: 'Magma', spectral: 'Spectral', rdylgn: 'Red–yellow–green', blues: 'Blues' },
    stretches: { cut: '2% – 98%', minmax: 'Min – max', deviation: 'Mean ± 2σ', none: 'No stretch', custom: 'Custom' },
    ramp: 'Colour ramp',
    stretch: 'Stretch',
    mode: 'Mode',
    modes: { composite: 'Three bands', single: 'One band' },
    band: 'Band',
    columns: { low: '2%', high: '98%', mean: 'Mean' },
    bandAs: (band, channel) => `Band ${band} as ${['red', 'green', 'blue'][channel]}`,
    measures: { min: 'Min', max: 'Max', mean: 'Mean', std: 'Std dev' },
    sampled: 'From a sample',
    openPanel: 'Show the panel',
    closePanel: 'Hide the panel',
    pickHint: 'Click a feature on the map to see its attributes.',
    nth: (position, total) => `Feature ${position} of ${total}`,
    rows: (first, last, total) => `Rows ${first}–${last} of ${total}`,
    reach: 'Zoom to the feature',
    previousPage: 'Previous page',
    nextPage: 'Next page',
    info: { layer: 'Layer', geometry: 'Geometry', features: 'Features', fields: 'Fields', crs: 'Coordinate system', extent: 'Extent', size: 'Size', bands: 'Bands', nodata: 'no data' },
    partly: 'Part of the map could not be read.',
    unshown: {
      missing: 'The file is no longer there.',
      unopenable: 'This file could not be read as geographic data.',
      subdatasets: 'This file holds several datasets, which the preview cannot show yet.',
      'too-large': 'This layer is too large to draw.',
      'no-layer': 'The file has no such layer.',
      'no-crs': 'This data has no coordinate system, so it cannot be placed on the map.',
      'local-crs': 'This data uses a local coordinate system, so it cannot be placed on the map.',
      'not-degrees': 'The coordinates of this data are outside the range of longitude and latitude. It may use another coordinate system, so it cannot be placed on the map.',
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
    bands: (count) => `${count} 个波段`,
    shown: (bands) => `显示波段 ${bands}`,
    layer: '图层',
    forms: { points: '点', lines: '线', polygons: '面' },
    noCrs: '没有坐标系',
    close: '关闭',
    noAttributes: '这个要素没有属性。',
    zoomIn: '放大',
    zoomOut: '缩小',
    whole: '回到全图',
    tabs: { feature: '要素', table: '属性表', look: '显示', pixel: '像元', info: '信息' },
    pixelHint: '点击地图上的影像,查看这个像元的值。',
    pixel: { column: '列', row: '行', noData: '无数据' },
    ramps: { classes: '分类', grey: '灰度', terrain: '地形', viridis: 'Viridis', magma: '岩浆', spectral: '光谱', rdylgn: '红黄绿', blues: '蓝' },
    stretches: { cut: '2% – 98%', minmax: '最小 – 最大', deviation: '平均 ± 2σ', none: '不拉伸', custom: '自定义' },
    ramp: '色带',
    stretch: '拉伸',
    mode: '方式',
    modes: { composite: '三波段合成', single: '单个波段' },
    band: '波段',
    columns: { low: '2%', high: '98%', mean: '平均' },
    bandAs: (band, channel) => `波段 ${band} 作${['红', '绿', '蓝'][channel]}`,
    measures: { min: '最小值', max: '最大值', mean: '平均值', std: '标准差' },
    sampled: '取样',
    openPanel: '展开面板',
    closePanel: '收起面板',
    pickHint: '点击地图上的要素,查看它的属性。',
    nth: (position, total) => `第 ${position} 个要素,共 ${total} 个`,
    rows: (first, last, total) => `第 ${first} 到 ${last} 行,共 ${total} 行`,
    reach: '缩放到要素',
    previousPage: '上一页',
    nextPage: '下一页',
    info: { layer: '图层', geometry: '几何类型', features: '要素数', fields: '字段', crs: '坐标系', extent: '范围', size: '尺寸', bands: '波段', nodata: '无数据值' },
    partly: '地图有一部分没能读出来。',
    unshown: {
      missing: '文件已经不在了。',
      unopenable: '这个文件无法作为地理数据读取。',
      subdatasets: '这个文件里有多个数据集,暂不支持预览。',
      'too-large': '这个图层太大,无法绘制。',
      'no-layer': '文件里没有这个图层。',
      'no-crs': '这份数据没有坐标系,无法放到地图上。',
      'local-crs': '这份数据用的是本地坐标系,无法放到地图上。',
      'not-degrees': '这份数据的坐标不在经纬度的范围内,它用的可能是别的坐标系,无法放到地图上。',
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
    bands: (count) => `${count} 個波段`,
    shown: (bands) => `顯示波段 ${bands}`,
    layer: '圖層',
    forms: { points: '點', lines: '線', polygons: '面' },
    noCrs: '沒有座標系統',
    close: '關閉',
    noAttributes: '這個圖徵沒有屬性。',
    zoomIn: '放大',
    zoomOut: '縮小',
    whole: '回到全圖',
    tabs: { feature: '圖徵', table: '屬性表', look: '顯示', pixel: '像元', info: '資訊' },
    pixelHint: '點選地圖上的影像,檢視這個像元的值。',
    pixel: { column: '欄', row: '列', noData: '無資料' },
    ramps: { classes: '分類', grey: '灰階', terrain: '地形', viridis: 'Viridis', magma: '岩漿', spectral: '光譜', rdylgn: '紅黃綠', blues: '藍' },
    stretches: { cut: '2% – 98%', minmax: '最小 – 最大', deviation: '平均 ± 2σ', none: '不拉伸', custom: '自訂' },
    ramp: '色帶',
    stretch: '拉伸',
    mode: '方式',
    modes: { composite: '三波段合成', single: '單一波段' },
    band: '波段',
    columns: { low: '2%', high: '98%', mean: '平均' },
    bandAs: (band, channel) => `波段 ${band} 作${['紅', '綠', '藍'][channel]}`,
    measures: { min: '最小值', max: '最大值', mean: '平均值', std: '標準差' },
    sampled: '取樣',
    openPanel: '展開面板',
    closePanel: '收起面板',
    pickHint: '點選地圖上的圖徵,檢視它的屬性。',
    nth: (position, total) => `第 ${position} 個圖徵,共 ${total} 個`,
    rows: (first, last, total) => `第 ${first} 到 ${last} 列,共 ${total} 列`,
    reach: '縮放至圖徵',
    previousPage: '上一頁',
    nextPage: '下一頁',
    info: { layer: '圖層', geometry: '幾何類型', features: '圖徵數', fields: '欄位', crs: '座標系統', extent: '範圍', size: '尺寸', bands: '波段', nodata: '無資料值' },
    partly: '地圖有一部分沒能讀出來。',
    unshown: {
      missing: '檔案已經不在了。',
      unopenable: '這個檔案無法作為地理資料讀取。',
      subdatasets: '這個檔案裡有多個資料集,暫不支援預覽。',
      'too-large': '這個圖層太大,無法繪製。',
      'no-layer': '檔案裡沒有這個圖層。',
      'no-crs': '這份資料沒有座標系統,無法放到地圖上。',
      'local-crs': '這份資料用的是區域座標系統,無法放到地圖上。',
      'not-degrees': '這份資料的座標不在經緯度的範圍內,它用的可能是別的座標系統,無法放到地圖上。',
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

/** A longitude and a latitude as a map reads them out, in every language, to the ten metres or so that four decimals tell apart. */
export const placeText = (longitude: number, latitude: number): string =>
  `${Math.abs(longitude).toFixed(4)}°${longitude < 0 ? 'W' : 'E'}, ${Math.abs(latitude).toFixed(4)}°${latitude < 0 ? 'S' : 'N'}`;

export const unshownText = (text: PreviewText, code: string): string => text.unshown[code] ?? text.unshown.other;
