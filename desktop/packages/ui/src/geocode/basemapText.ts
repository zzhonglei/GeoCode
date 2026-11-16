import type { Locale } from '@/lib/i18n';
import type { BasemapStatus } from './geoStatus';

type Source = BasemapStatus['source'];
type Layer = BasemapStatus['tianditu']['layer'];

export const OPENFREEMAP_STYLES = { liberty: 'Liberty', bright: 'Bright', positron: 'Positron', fiord: 'Fiord' } satisfies Record<BasemapStatus['openfreemap'], string>;
export const VERSATILES_STYLES = { colorful: 'Colorful', gray: 'Gray', muted: 'Muted' } satisfies Record<BasemapStatus['versatiles'], string>;

export interface BasemapText {
  title: string;
  back: string;
  description: string;
  /** What the basemap is for, on its card in the overview. */
  cardDescription: string;
  names: Record<Source, string>;
  details: Record<Source, string>;
  layers: Record<Layer, string>;
  style: string;
  layer: string;
  key: string;
  keyPlaceholder: string;
  keySaved: string;
  keyHelp: [string, string];
  url: string;
  urlHelp: string;
  urlInvalid: string;
  attribution: string;
  attributionHelp: string;
  use: string;
  missing: string;
  failed: (reason: string) => string;
}

const TEXT: { en: BasemapText } & Partial<Record<Locale, BasemapText>> = {
  en: {
    title: 'Basemap',
    back: 'Geo environment',
    description: 'Drawn under geographic data, in the files view and in the maps the agent shows.',
    cardDescription: 'Reference map under your data',
    names: {
      offline: 'Offline basemap',
      openfreemap: 'OpenFreeMap',
      versatiles: 'VersaTiles',
      osm: 'OpenStreetMap',
      tianditu: 'Tianditu',
      custom: 'Custom',
      none: 'None',
    },
    details: {
      offline: 'Comes with GeoCode and works without a network, to zoom 6',
      openfreemap: 'Online vector map, to street level',
      versatiles: 'Online vector map, to street level; place names in English or local',
      osm: 'Online, OpenStreetMap’s standard map',
      tianditu: 'Online, for mainland China; needs your own key',
      custom: 'The tiles of an XYZ address of your own',
      none: 'The data on a plain background',
    },
    layers: { vec: 'Map', img: 'Imagery', ter: 'Terrain' },
    style: 'Style',
    layer: 'Layer',
    key: 'Key',
    keyPlaceholder: 'Tianditu key',
    keySaved: 'A key is saved; enter another to replace it',
    keyHelp: ['Apply for a key of the server type in the ', '; a browser key is refused.'],
    url: 'Address',
    urlHelp: 'An http or https address with {z}, {x} and {y}, and {s} for its servers a, b and c. Whether its terms allow this use is yours to check.',
    urlInvalid: 'The address must start with http:// or https:// and contain {z}, {x} and {y}; {s} is the only other placeholder.',
    attribution: 'Credit',
    attributionHelp: 'Shown small in the corner of the map, as the provider asks.',
    use: 'Use',
    missing: 'This installation lacks the offline basemap’s files.',
    failed: (reason) => `The basemap could not be changed: ${reason}`,
  },
  'zh-CN': {
    title: '底图',
    back: '地理环境',
    description: '画在地理数据下面，用于文件预览与智能体展示的地图。',
    cardDescription: '地图显示的参考底图',
    names: {
      offline: '离线底图',
      openfreemap: 'OpenFreeMap',
      versatiles: 'VersaTiles',
      osm: 'OpenStreetMap',
      tianditu: '天地图',
      custom: '自定义',
      none: '不显示',
    },
    details: {
      offline: '随 GeoCode 安装，不联网也能显示，到第 6 级',
      openfreemap: '在线矢量地图，能放大到街道',
      versatiles: '在线矢量地图，能放大到街道；地名为英文或当地文字',
      osm: '在线，OpenStreetMap 的标准地图',
      tianditu: '在线，供中国大陆使用；需要自己的 key',
      custom: '自己给出的 XYZ 瓦片地址',
      none: '数据画在空白背景上',
    },
    layers: { vec: '矢量', img: '影像', ter: '地形' },
    style: '样式',
    layer: '图层',
    key: 'Key',
    keyPlaceholder: '天地图的 key',
    keySaved: '已保存 key，输入新的可以替换',
    keyHelp: ['在', '申请「服务端」类型的 key，浏览器端的 key 会被拒绝。'],
    url: '地址',
    urlHelp: 'http 或 https 地址，含 {z}、{x}、{y}，可用 {s} 表示服务器 a、b、c。是否符合服务方的条款，请自行确认。',
    urlInvalid: '地址要以 http:// 或 https:// 开头，并含 {z}、{x}、{y}；此外只能用 {s}。',
    attribution: '署名',
    attributionHelp: '按服务方的要求，以小字显示在地图的角落。',
    use: '使用',
    missing: '这次安装缺少离线底图的文件。',
    failed: (reason) => `无法更改底图：${reason}`,
  },
  'zh-TW': {
    title: '底圖',
    back: '地理環境',
    description: '畫在地理資料下面，用於檔案預覽與智慧體展示的地圖。',
    cardDescription: '地圖顯示的參考底圖',
    names: {
      offline: '離線底圖',
      openfreemap: 'OpenFreeMap',
      versatiles: 'VersaTiles',
      osm: 'OpenStreetMap',
      tianditu: '天地圖',
      custom: '自訂',
      none: '不顯示',
    },
    details: {
      offline: '隨 GeoCode 安裝，不連網也能顯示，到第 6 級',
      openfreemap: '線上向量地圖，能放大到街道',
      versatiles: '線上向量地圖，能放大到街道；地名為英文或當地文字',
      osm: '線上，OpenStreetMap 的標準地圖',
      tianditu: '線上，供中國大陸使用；需要自己的 key',
      custom: '自己提供的 XYZ 圖磚網址',
      none: '資料畫在空白背景上',
    },
    layers: { vec: '向量', img: '影像', ter: '地形' },
    style: '樣式',
    layer: '圖層',
    key: 'Key',
    keyPlaceholder: '天地圖的 key',
    keySaved: '已儲存 key，輸入新的可以替換',
    keyHelp: ['在', '申請「服務端」類型的 key，瀏覽器端的 key 會被拒絕。'],
    url: '網址',
    urlHelp: 'http 或 https 網址，含 {z}、{x}、{y}，可用 {s} 表示伺服器 a、b、c。是否符合服務方的條款，請自行確認。',
    urlInvalid: '網址要以 http:// 或 https:// 開頭，並含 {z}、{x}、{y}；此外只能用 {s}。',
    attribution: '署名',
    attributionHelp: '依服務方的要求，以小字顯示在地圖的角落。',
    use: '使用',
    missing: '這次安裝缺少離線底圖的檔案。',
    failed: (reason) => `無法變更底圖：${reason}`,
  },
};

export const basemapText = (locale: Locale): BasemapText => TEXT[locale] ?? TEXT.en;

/** The settings' basemap in a line: its name, and its style or layer where it has them. */
export const basemapLineOf = (status: BasemapStatus | undefined, text: BasemapText) => {
  if (!status) return undefined;
  const name = text.names[status.source];
  if (status.source === 'openfreemap') return `${name} · ${OPENFREEMAP_STYLES[status.openfreemap]}`;
  if (status.source === 'versatiles') return `${name} · ${VERSATILES_STYLES[status.versatiles]}`;
  if (status.source === 'tianditu') return `${name} · ${text.layers[status.tianditu.layer]}`;
  return name;
};
