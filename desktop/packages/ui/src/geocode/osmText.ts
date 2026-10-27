import type { Locale } from '@/lib/i18n';

export type Kind = 'point' | 'line' | 'area';
type Layer = 'points' | 'lines' | 'polygons';

/** A download's steps, in the order it takes them. */
export const OSM_STEPS = ['area', 'count', 'download', 'assemble', 'write'] as const;

export type OsmStep = (typeof OSM_STEPS)[number];

/**
 * What the OSM tools' rows say (docs/OSM.md, section 9), in the interface's language: the tools' results are facts
 * the interface words itself. What a server said stays as it said it.
 */
export type OsmText = {
  /** The titles of a search's and a look's rows, and of a download's when GeoAgent gave it no label. */
  search: string;
  probe: string;
  download: string;
  /** The downloads' names in the settings' rules, told apart. */
  downloadObjects: string;
  downloadFeatures: string;
  /** The permission card's summary of what each tool asks to do. */
  asks: Record<'osmsearch' | 'osmprobe' | 'osmgetobjects' | 'osmgetfeatures', string>;
  /** The lines of the tools' permission cards (docs/OSM.md, section 8). */
  card: {
    objects: string;
    tags: string;
    area: string;
    geometry: string;
    point: string;
    search: string;
    look: string;
    /** Between the objects a line lists. */
    separator: string;
    only: (category: string) => string;
    /** The words before and after the place an area lies around. */
    around: (meters: string) => readonly [string, string];
    box: (from: string, to: string) => string;
    file: (path: string, layer: string | undefined) => string;
    /** The words before and after the tags a look counts. */
    counts: readonly [string, string];
    term: (term: string) => string;
  };
  /** What a look at keys is about. */
  values: (keys: string) => string;
  kinds: Record<Kind, string>;
  layers: Record<Layer, string>;
  moreCandidates: (count: number) => string;
  moreValues: (count: number) => string;
  contextMissing: (place: string) => string;
  incomplete: string;
  fallback: (category: string) => string;
  nothingFound: string;
  noTerm: (term: string) => string;
  /** Before the ways of tagging no feature in the area carries. */
  noneHere: string;
  /** Before the ways of tagging the server stopped before counting. */
  notCounted: string;
  added: string;
  deprecated: string;
  anyOf: (count: string) => string;
  others: (count: number) => string;
  keyFeatures: (count: string) => string;
  sampled: string;
  stoppedEarly: string;
  steps: Record<OsmStep, string>;
  /** What a download's row says while it is on a step. */
  doing: Record<OsmStep, string>;
  downloadingPart: (part: number, parts: number) => string;
  busy: string;
  /** What a look's or a download's row says while it waits for the one before it. */
  queued: string;
  /** What a step on a server says until its answer arrives. */
  querying: (since: string) => string;
  /** What a download says once it has gone a while without progress, no server working on a query. */
  waiting: (since: string) => string;
  counted: (features: string | undefined, parts: number) => string;
  part: (part: number, parts: number) => string;
  received: (size: string) => string;
  /** Whole seconds, as a wait is said. */
  duration: (seconds: number) => string;
  features: (count: string) => string;
  asOf: (time: string) => string;
  columns: (count: number) => string;
  partMissing: (box: string) => string;
  absent: (ids: string) => string;
  unassembled: (ids: string) => string;
  /** Objects a download by id did not get, as no server made progress for `minutes`, or none could be reached. */
  undownloaded: (ids: string, minutes: number | undefined) => string;
  serverStopped: string;
  empty: (tags: string) => string;
  emptyObjects: string;
  refused: (count: string, limit: string) => string;
  failures: {
    stalled: (minutes: number) => string;
    stalledDownload: (minutes: number) => string;
    unanswered: string;
    refused: string;
    invalid: string;
    tooLarge: string;
    unwritable: string;
    notReady: string;
    /** The user declined the call when asked about it. */
    declined: string;
    interrupted: string;
    interruptedDownload: string;
    other: string;
  };
};

const TEXT: { en: OsmText } & Partial<Record<Locale, OsmText>> = {
  en: {
    search: 'OpenStreetMap Search',
    probe: 'OpenStreetMap Tags',
    download: 'Download OpenStreetMap Data',
    downloadObjects: 'Download OpenStreetMap Objects',
    downloadFeatures: 'Download OpenStreetMap Features',
    asks: {
      osmsearch: 'Request to search OpenStreetMap',
      osmprobe: 'Request to check OpenStreetMap tags',
      osmgetobjects: 'Request to download OpenStreetMap objects',
      osmgetfeatures: 'Request to download OpenStreetMap features',
    },
    card: {
      objects: 'Objects',
      tags: 'Tags',
      area: 'Area',
      geometry: 'Geometry',
      point: 'one point per feature',
      search: 'Search',
      look: 'Check',
      separator: ', ',
      only: (category) => `only ${category}`,
      around: (meters) => [`within ${meters} m of `, ''],
      box: (from, to) => `the box from ${from} to ${to}`,
      file: (path, layer) => (layer ? `layer ${layer} of the boundary file ${path}` : `the boundary file ${path}`),
      counts: ['how many have ', ''],
      term: (term) => `how OSM tags “${term}”`,
    },
    values: (keys) => `values of ${keys}`,
    kinds: { point: 'point', line: 'line', area: 'area' },
    layers: { points: 'points', lines: 'lines', polygons: 'polygons' },
    moreCandidates: (count) => `${count} more ${count === 1 ? 'candidate' : 'candidates'}`,
    moreValues: (count) => `${count} more`,
    contextMissing: (place) => `No place called “${place}” was found, so the search was not narrowed to it.`,
    incomplete: 'Some of the search services did not answer, so this may not be everything.',
    fallback: (category) => `No ${category} object has this name; these are the named ${category} objects there.`,
    nothingFound: 'Nothing found.',
    noTerm: (term) => `OSM’s tagging conventions have nothing called “${term}”.`,
    noneHere: 'None here: ',
    notCounted: 'Not counted before the server stopped: ',
    added: 'added',
    deprecated: 'deprecated',
    anyOf: (count) => `Any of them: ${count} features`,
    others: (count) => `${count} other values`,
    keyFeatures: (count) => `${count} features`,
    sampled: 'The area has many features; these values are from part of them.',
    stoppedEarly: 'The server stopped early, so the counts may be low.',
    steps: {
      area: 'Read the area',
      count: 'Count',
      download: 'Download',
      assemble: 'Assemble geometries',
      write: 'Write the file',
    },
    doing: {
      area: 'Reading the area',
      count: 'Counting features',
      download: 'Downloading',
      assemble: 'Assembling geometries',
      write: 'Writing the file',
    },
    downloadingPart: (part, parts) => `Downloading part ${part} of ${parts}`,
    busy: 'Servers busy, trying again',
    queued: 'Queued until the check or download before it finishes',
    querying: (since) => `Server working on the query, ${since} so far`,
    waiting: (since) => `Waiting for the server, ${since} so far`,
    counted: (features, parts) =>
      features === undefined
        ? `in ${parts} parts`
        : parts > 1
          ? `${features} features, in ${parts} parts`
          : `${features} features`,
    part: (part, parts) => `part ${part} of ${parts}`,
    received: (size) => `${size} received`,
    duration: (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`),
    features: (count) => `${count} features`,
    asOf: (time) => `Data as of ${time}`,
    columns: (count) => `${count} columns: `,
    partMissing: (box) => `One part was not downloaded in full: ${box}. A smaller area may come through.`,
    absent: (ids) => `OSM has no ${ids}.`,
    unassembled: (ids) => `No whole geometry could be assembled for ${ids}, so they were left out.`,
    undownloaded: (ids, minutes) =>
      minutes === undefined
        ? `${ids} could not be downloaded: OpenStreetMap’s public servers cannot be reached, or are all too busy.`
        : `${ids} could not be downloaded: OpenStreetMap’s public servers made no progress for ${minutes} minutes, and may be too busy.`,
    serverStopped: 'The server stopped early, so the data may be incomplete.',
    empty: (tags) => `There is no ${tags} here, so no file was written.`,
    emptyObjects: 'OSM has none of these objects, so no file was written.',
    refused: (count, limit) =>
      `About ${count} features, more than an online download can take (${limit}), so nothing was downloaded. Try a smaller area, or fewer kinds of features at a time.`,
    failures: {
      stalled: (minutes) =>
        `No progress for ${minutes} minutes, so it stopped. OpenStreetMap’s public servers may be too busy; try again later.`,
      stalledDownload: (minutes) =>
        `No progress for ${minutes} minutes, so the download stopped and what it had was discarded. OpenStreetMap’s public servers may be too busy; try again later.`,
      unanswered: 'OpenStreetMap’s public servers cannot be reached, or are all too busy.',
      refused: 'The server refused the query.',
      invalid: 'The request was not written right.',
      tooLarge: 'OpenStreetMap’s answer was too large to take.',
      unwritable: 'No file can be written in this folder, so nothing was downloaded.',
      notReady: 'GeoCode’s Python environment is still being prepared; try again in a minute.',
      declined: 'Declined.',
      interrupted: 'Interrupted.',
      interruptedDownload: 'Interrupted; what was downloaded was discarded.',
      other: 'Something went wrong.',
    },
  },
  'zh-CN': {
    search: 'OpenStreetMap 检索',
    probe: 'OpenStreetMap 标签',
    download: '下载 OpenStreetMap 数据',
    downloadObjects: '下载 OpenStreetMap 对象',
    downloadFeatures: '下载 OpenStreetMap 要素',
    asks: {
      osmsearch: '请求检索 OpenStreetMap',
      osmprobe: '请求查看 OpenStreetMap 标签',
      osmgetobjects: '请求下载 OpenStreetMap 对象',
      osmgetfeatures: '请求下载 OpenStreetMap 要素',
    },
    card: {
      objects: '对象',
      tags: '标签',
      area: '范围',
      geometry: '几何',
      point: '每个要素取一个点',
      search: '检索',
      look: '查看',
      separator: '、',
      only: (category) => `只找 ${category}`,
      around: (meters) => ['', ` 周围 ${meters} 米`],
      box: (from, to) => `${from} 至 ${to} 的矩形`,
      file: (path, layer) => (layer ? `边界文件 ${path} 的图层 ${layer}` : `边界文件 ${path}`),
      counts: ['', ' 的数量'],
      term: (term) => `“${term}”的写法`,
    },
    values: (keys) => `${keys} 的取值`,
    kinds: { point: '点', line: '线', area: '面' },
    layers: { points: '点', lines: '线', polygons: '面' },
    moreCandidates: (count) => `还有 ${count} 个候选`,
    moreValues: (count) => `还有 ${count} 种`,
    contextMissing: (place) => `没有找到“${place}”这个地方，检索没有限定在那里。`,
    incomplete: '有一部分检索服务没有回答，结果可能不全。',
    fallback: (category) => `没有叫这个名字的 ${category} 对象，下面是那里有名字的 ${category} 对象。`,
    nothingFound: '没有找到。',
    noTerm: (term) => `OSM 的标注规范里没有叫“${term}”的东西。`,
    noneHere: '这里没有：',
    notCounted: '服务器停下前没来得及数：',
    added: '附带',
    deprecated: '已弃用',
    anyOf: (count) => `满足任一：${count} 个要素`,
    others: (count) => `其余 ${count} 种`,
    keyFeatures: (count) => `${count} 个要素`,
    sampled: '要素太多，这些取值只统计了其中一部分。',
    stoppedEarly: '服务器中途停下了，数量可能偏少。',
    steps: { area: '读取范围', count: '计数', download: '下载', assemble: '组装几何', write: '写入文件' },
    doing: {
      area: '正在读取范围',
      count: '正在计数',
      download: '正在下载',
      assemble: '正在组装几何',
      write: '正在写入文件',
    },
    downloadingPart: (part, parts) => `正在下载第 ${part} 块，共 ${parts} 块`,
    busy: '服务器繁忙，正在重试',
    queued: '排队中，等上一个查看或下载完成',
    querying: (since) => `服务器正在查询，已等 ${since}`,
    waiting: (since) => `等服务器回应，已等 ${since}`,
    counted: (features, parts) =>
      features === undefined
        ? `分 ${parts} 块下载`
        : parts > 1
          ? `${features} 个要素，分 ${parts} 块下载`
          : `${features} 个要素`,
    part: (part, parts) => `第 ${part} 块，共 ${parts} 块`,
    received: (size) => `已收到 ${size}`,
    duration: (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`),
    features: (count) => `${count} 个要素`,
    asOf: (time) => `数据截至 ${time}`,
    columns: (count) => `${count} 列：`,
    partMissing: (box) => `有一块没有下全，范围是 ${box}。缩小范围再下一次可能就有了。`,
    absent: (ids) => `OSM 里没有 ${ids}。`,
    unassembled: (ids) => `${ids} 拼不出完整的几何，没有写入。`,
    undownloaded: (ids, minutes) =>
      minutes === undefined
        ? `${ids} 没能下载：OpenStreetMap 的公共服务器连不上，或者都太忙。`
        : `${ids} 没能下载：OpenStreetMap 的公共服务器 ${minutes} 分钟没有进展，可能太忙。`,
    serverStopped: '服务器中途停下了，数据可能不全。',
    empty: (tags) => `这个范围里没有 ${tags} 的要素，没有写文件。`,
    emptyObjects: 'OSM 里没有这些对象，没有写文件。',
    refused: (count, limit) =>
      `约 ${count} 个要素，超过在线下载的上限 ${limit} 个，没有下载。可以缩小范围，或一次少下几种要素。`,
    failures: {
      stalled: (minutes) => `${minutes} 分钟没有进展，已经停下。OpenStreetMap 的公共服务器可能太忙，可以过一会儿再试。`,
      stalledDownload: (minutes) =>
        `${minutes} 分钟没有进展，已经停下，下了的部分已丢弃。OpenStreetMap 的公共服务器可能太忙，可以过一会儿再试。`,
      unanswered: 'OpenStreetMap 的公共服务器连不上，或者都太忙。',
      refused: '服务器拒绝了这次查询。',
      invalid: '请求写得不对。',
      tooLarge: 'OpenStreetMap 的回答太大，收不下。',
      unwritable: '这个文件夹里写不了文件，没有下载。',
      notReady: 'GeoCode 的 Python 环境还在准备，过一会儿再试。',
      declined: '已拒绝。',
      interrupted: '已中断。',
      interruptedDownload: '已中断，下了的部分已丢弃。',
      other: '出错了。',
    },
  },
  'zh-TW': {
    search: 'OpenStreetMap 檢索',
    probe: 'OpenStreetMap 標籤',
    download: '下載 OpenStreetMap 資料',
    downloadObjects: '下載 OpenStreetMap 物件',
    downloadFeatures: '下載 OpenStreetMap 圖徵',
    asks: {
      osmsearch: '請求檢索 OpenStreetMap',
      osmprobe: '請求查看 OpenStreetMap 標籤',
      osmgetobjects: '請求下載 OpenStreetMap 物件',
      osmgetfeatures: '請求下載 OpenStreetMap 圖徵',
    },
    card: {
      objects: '物件',
      tags: '標籤',
      area: '範圍',
      geometry: '幾何',
      point: '每個圖徵取一個點',
      search: '檢索',
      look: '查看',
      separator: '、',
      only: (category) => `只找 ${category}`,
      around: (meters) => ['', ` 周圍 ${meters} 公尺`],
      box: (from, to) => `${from} 至 ${to} 的矩形`,
      file: (path, layer) => (layer ? `邊界檔案 ${path} 的圖層 ${layer}` : `邊界檔案 ${path}`),
      counts: ['', ' 的數量'],
      term: (term) => `「${term}」的寫法`,
    },
    values: (keys) => `${keys} 的取值`,
    kinds: { point: '點', line: '線', area: '面' },
    layers: { points: '點', lines: '線', polygons: '面' },
    moreCandidates: (count) => `還有 ${count} 個候選`,
    moreValues: (count) => `還有 ${count} 種`,
    contextMissing: (place) => `找不到「${place}」這個地方，檢索沒有限定在那裡。`,
    incomplete: '有一部分檢索服務沒有回應，結果可能不完整。',
    fallback: (category) => `沒有叫這個名稱的 ${category} 物件，以下是那裡有名稱的 ${category} 物件。`,
    nothingFound: '沒有找到。',
    noTerm: (term) => `OSM 的標註規範裡沒有叫「${term}」的東西。`,
    noneHere: '這裡沒有：',
    notCounted: '伺服器停下前沒來得及數：',
    added: '附帶',
    deprecated: '已棄用',
    anyOf: (count) => `符合任一：${count} 個圖徵`,
    others: (count) => `其餘 ${count} 種`,
    keyFeatures: (count) => `${count} 個圖徵`,
    sampled: '圖徵太多，這些取值只統計了其中一部分。',
    stoppedEarly: '伺服器中途停下了，數量可能偏少。',
    steps: { area: '讀取範圍', count: '計數', download: '下載', assemble: '組裝幾何', write: '寫入檔案' },
    doing: {
      area: '正在讀取範圍',
      count: '正在計數',
      download: '正在下載',
      assemble: '正在組裝幾何',
      write: '正在寫入檔案',
    },
    downloadingPart: (part, parts) => `正在下載第 ${part} 塊，共 ${parts} 塊`,
    busy: '伺服器忙碌，正在重試',
    queued: '排隊中，等上一個查看或下載完成',
    querying: (since) => `伺服器正在查詢，已等 ${since}`,
    waiting: (since) => `等待伺服器回應，已等 ${since}`,
    counted: (features, parts) =>
      features === undefined
        ? `分 ${parts} 塊下載`
        : parts > 1
          ? `${features} 個圖徵，分 ${parts} 塊下載`
          : `${features} 個圖徵`,
    part: (part, parts) => `第 ${part} 塊，共 ${parts} 塊`,
    received: (size) => `已收到 ${size}`,
    duration: (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`),
    features: (count) => `${count} 個圖徵`,
    asOf: (time) => `資料截至 ${time}`,
    columns: (count) => `${count} 欄：`,
    partMissing: (box) => `有一塊沒有下載完整，範圍是 ${box}。縮小範圍再下載一次可能就有了。`,
    absent: (ids) => `OSM 裡沒有 ${ids}。`,
    unassembled: (ids) => `${ids} 組不出完整的幾何，沒有寫入。`,
    undownloaded: (ids, minutes) =>
      minutes === undefined
        ? `${ids} 無法下載：OpenStreetMap 的公共伺服器連不上，或者都太忙。`
        : `${ids} 無法下載：OpenStreetMap 的公共伺服器 ${minutes} 分鐘沒有進展，可能太忙。`,
    serverStopped: '伺服器中途停下了，資料可能不完整。',
    empty: (tags) => `這個範圍裡沒有 ${tags} 的圖徵，沒有寫入檔案。`,
    emptyObjects: 'OSM 裡沒有這些物件，沒有寫入檔案。',
    refused: (count, limit) =>
      `約 ${count} 個圖徵，超過線上下載的上限 ${limit} 個，沒有下載。可以縮小範圍，或一次少下載幾種圖徵。`,
    failures: {
      stalled: (minutes) => `${minutes} 分鐘沒有進展，已經停下。OpenStreetMap 的公共伺服器可能太忙，可以過一會兒再試。`,
      stalledDownload: (minutes) =>
        `${minutes} 分鐘沒有進展，已經停下，已下載的部分已捨棄。OpenStreetMap 的公共伺服器可能太忙，可以過一會兒再試。`,
      unanswered: 'OpenStreetMap 的公共伺服器連不上，或者都太忙。',
      refused: '伺服器拒絕了這次查詢。',
      invalid: '請求寫得不對。',
      tooLarge: 'OpenStreetMap 的回答太大，收不下。',
      unwritable: '這個資料夾裡寫不了檔案，沒有下載。',
      notReady: 'GeoCode 的 Python 環境還在準備，過一會兒再試。',
      declined: '已拒絕。',
      interrupted: '已中斷。',
      interruptedDownload: '已中斷，已下載的部分已捨棄。',
      other: '發生錯誤。',
    },
  },
};

export const osmText = (locale: Locale): OsmText => TEXT[locale] ?? TEXT.en;
