import type { Locale } from '@/lib/i18n';
import type { BasemapFault, BasemapStatus } from './geoStatus';

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
  /** The list's groups. */
  groups: { offline: string; online: string; other: string };
  names: Record<Source, string>;
  /** Each basemap in a line, under its name. */
  descriptions: Record<Source, string>;
  layers: Record<Layer, string>;
  /** The name of a row's styles, as buttons or as the menu they go into where they do not fit beside it. */
  style: string;
  layer: string;
  /** Tianditu's key button: its tooltip, with a key saved or none. */
  keySaved: string;
  noKey: string;
  edit: string;
  setAddress: string;
  keyTitle: string;
  keyDescription: string;
  keyPlaceholder: string;
  /** The help under the key, around the link to Tianditu's console. */
  keyHelp: [string, string];
  console: string;
  customTitle: string;
  customDescription: string;
  address: string;
  addressHelp: string;
  addressInvalid: string;
  credit: string;
  creditPlaceholder: string;
  save: string;
  use: string;
  cancel: string;
  preview: string;
  previewDescription: string;
  /** On the preview, briefly, when it shows no basemap. */
  veil: Record<BasemapFault, string>;
  /** Under the preview, why it shows none: Tianditu's key may be why its tiles cannot be loaded; GeoEngine says where a block is wrong. */
  why: Record<Exclude<BasemapFault, 'invalid'>, string> & { unreachableKey: string; invalid: (reason: string) => string };
  failed: (reason: string) => string;
}

const TEXT: { en: BasemapText } & Partial<Record<Locale, BasemapText>> = {
  en: {
    title: 'Basemap',
    back: 'Geo environment',
    description: 'The reference map under geographic data, in file previews and the maps the agent shows.',
    cardDescription: 'Reference map under your data',
    groups: { offline: 'Offline', online: 'Online', other: 'Other' },
    names: {
      offline: 'Offline basemap',
      openfreemap: 'OpenFreeMap',
      versatiles: 'VersaTiles',
      osm: 'OpenStreetMap',
      tianditu: 'Tianditu',
      custom: 'Custom',
      none: 'None',
    },
    descriptions: {
      offline: 'Comes with GeoCode and works offline',
      openfreemap: 'Open online vector map',
      versatiles: 'Open online vector map; names in English or local',
      osm: 'OpenStreetMap’s standard map',
      tianditu: 'Online map for mainland China; needs a key',
      custom: 'Your own XYZ tile address',
      none: 'Only the data, no basemap under it',
    },
    layers: { vec: 'Map', img: 'Imagery', ter: 'Terrain' },
    style: 'Style',
    layer: 'Layer',
    keySaved: 'A key is saved',
    noKey: 'No key yet',
    edit: 'Edit',
    setAddress: 'Enter an address',
    keyTitle: 'Tianditu key',
    keyDescription: 'The key stays on this computer and is used to download Tianditu’s tiles.',
    keyPlaceholder: 'Tianditu server key',
    keyHelp: ['Apply for a key of the server type in the ', '; a browser key is refused.'],
    console: 'Tianditu console',
    customTitle: 'Custom basemap',
    customDescription: 'Any XYZ tile service, such as one of your own or your organisation’s.',
    address: 'Tile address',
    addressHelp: 'With {z}, {x} and {y}, and {s} for servers a, b and c; whether its terms allow this use is yours to check.',
    addressInvalid: 'Start with http:// or https:// and contain {z}, {x} and {y}; {s} is the only other placeholder.',
    credit: 'Credit',
    creditPlaceholder: 'Optional, such as © provider',
    save: 'Save',
    use: 'Use',
    cancel: 'Cancel',
    preview: 'Preview',
    previewDescription: 'The basemap as it draws the whole world',
    veil: { unreachable: 'Cannot be loaded', missing: 'The offline basemap’s files are missing', invalid: 'The basemap’s settings are written wrong' },
    why: {
      unreachable: 'The tiles cannot be loaded: there is no network, or the provider refused.',
      unreachableKey: 'The tiles cannot be loaded: there is no network, or the key is not valid.',
      missing: 'This installation lacks the offline basemap’s files.',
      invalid: (reason) => `The basemap entry in machine.json is written wrong, and the basemap cannot be changed until the file is fixed: ${reason}`,
    },
    failed: (reason) => `The basemap could not be changed: ${reason}`,
  },
  'zh-CN': {
    title: '底图',
    back: '地理环境',
    description: '画在地理数据下面的参考地图，用于文件预览与智能体展示的地图。',
    cardDescription: '地图显示的参考底图',
    groups: { offline: '离线', online: '在线', other: '其他' },
    names: {
      offline: '离线底图',
      openfreemap: 'OpenFreeMap',
      versatiles: 'VersaTiles',
      osm: 'OpenStreetMap',
      tianditu: '天地图',
      custom: '自定义',
      none: '不显示',
    },
    descriptions: {
      offline: '随 GeoCode 安装，不联网也能显示',
      openfreemap: '开源的在线矢量地图',
      versatiles: '开源的在线矢量地图，地名为英文或当地文字',
      osm: 'OpenStreetMap 的标准地图',
      tianditu: '中国大陆可用的在线地图，需要 key',
      custom: '自己的 XYZ 瓦片地址',
      none: '只显示数据，不垫底图',
    },
    layers: { vec: '矢量', img: '影像', ter: '地形' },
    style: '样式',
    layer: '图层',
    keySaved: 'Key 已保存',
    noKey: '还没有 key',
    edit: '修改',
    setAddress: '填写地址',
    keyTitle: '天地图的 key',
    keyDescription: 'key 只保存在这台电脑上，用来向天地图下载瓦片。',
    keyPlaceholder: '天地图的服务端 key',
    keyHelp: ['在', '申请「服务端」类型的 key，浏览器端的 key 会被拒绝。'],
    console: '天地图控制台',
    customTitle: '自定义底图',
    customDescription: '任何 XYZ 瓦片服务都可以，例如自己架设的或单位内部的。',
    address: '瓦片地址',
    addressHelp: '含 {z}、{x}、{y}，可用 {s} 表示服务器 a、b、c；是否符合服务方的条款请自行确认。',
    addressInvalid: '要以 http:// 或 https:// 开头，并含 {z}、{x}、{y}；此外只能用 {s}。',
    credit: '署名',
    creditPlaceholder: '可选，如 © 服务方名称',
    save: '保存',
    use: '使用',
    cancel: '取消',
    preview: '预览',
    previewDescription: '现在的底图在全球范围的样子',
    veil: { unreachable: '加载不出来', missing: '缺少离线底图的文件', invalid: '底图的设置写错了' },
    why: {
      unreachable: '瓦片加载不出来：没有网络，或服务方拒绝了请求。',
      unreachableKey: '瓦片加载不出来：没有网络，或 key 无效。',
      missing: '这次安装缺少离线底图的文件。',
      invalid: (reason) => `设置文件 machine.json 里底图一项写错了，改好这个文件才能更改底图：${reason}`,
    },
    failed: (reason) => `无法更改底图：${reason}`,
  },
  'zh-TW': {
    title: '底圖',
    back: '地理環境',
    description: '畫在地理資料下面的參考地圖，用於檔案預覽與智慧體展示的地圖。',
    cardDescription: '地圖顯示的參考底圖',
    groups: { offline: '離線', online: '線上', other: '其他' },
    names: {
      offline: '離線底圖',
      openfreemap: 'OpenFreeMap',
      versatiles: 'VersaTiles',
      osm: 'OpenStreetMap',
      tianditu: '天地圖',
      custom: '自訂',
      none: '不顯示',
    },
    descriptions: {
      offline: '隨 GeoCode 安裝，不連網也能顯示',
      openfreemap: '開源的線上向量地圖',
      versatiles: '開源的線上向量地圖，地名為英文或當地文字',
      osm: 'OpenStreetMap 的標準地圖',
      tianditu: '中國大陸可用的線上地圖，需要 key',
      custom: '自己的 XYZ 圖磚網址',
      none: '只顯示資料，不墊底圖',
    },
    layers: { vec: '向量', img: '影像', ter: '地形' },
    style: '樣式',
    layer: '圖層',
    keySaved: 'Key 已儲存',
    noKey: '還沒有 key',
    edit: '修改',
    setAddress: '填寫網址',
    keyTitle: '天地圖的 key',
    keyDescription: 'key 只儲存在這台電腦上，用來向天地圖下載圖磚。',
    keyPlaceholder: '天地圖的服務端 key',
    keyHelp: ['在', '申請「服務端」類型的 key，瀏覽器端的 key 會被拒絕。'],
    console: '天地圖控制台',
    customTitle: '自訂底圖',
    customDescription: '任何 XYZ 圖磚服務都可以，例如自己架設的或單位內部的。',
    address: '圖磚網址',
    addressHelp: '含 {z}、{x}、{y}，可用 {s} 表示伺服器 a、b、c；是否符合服務方的條款請自行確認。',
    addressInvalid: '要以 http:// 或 https:// 開頭，並含 {z}、{x}、{y}；此外只能用 {s}。',
    credit: '署名',
    creditPlaceholder: '可選，如 © 服務方名稱',
    save: '儲存',
    use: '使用',
    cancel: '取消',
    preview: '預覽',
    previewDescription: '現在的底圖在全球範圍的樣子',
    veil: { unreachable: '載入不出來', missing: '缺少離線底圖的檔案', invalid: '底圖的設定寫錯了' },
    why: {
      unreachable: '圖磚載入不出來：沒有網路，或服務方拒絕了請求。',
      unreachableKey: '圖磚載入不出來：沒有網路，或 key 無效。',
      missing: '這次安裝缺少離線底圖的檔案。',
      invalid: (reason) => `設定檔 machine.json 裡底圖一項寫錯了，改好這個檔案才能變更底圖：${reason}`,
    },
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
