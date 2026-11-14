import type { Locale } from '@/lib/i18n/runtime';

type DatasetText = {
  /** A rename refused for giving a dataset's main file another extension. */
  extensionKept: (name: string, extension: string) => string;
  /** Under a delete's question: the sidecars that go with the file. */
  partsGoAlong: (parts: readonly string[]) => string;
  /** After a delete: the sidecars that could not be deleted with their main file. */
  partsLeft: (parts: readonly string[]) => string;
  /** After a rename that failed and could not be undone: where each file of the dataset now is. */
  datasetSplit: (paths: readonly string[]) => string;
  /** A new file refused for having the name of a sidecar the tree does not list. */
  sidecarTaken: (name: string, owner: string) => string;
  /** Under an upload's replace question: the sidecars of the old data that replacing deletes. */
  partsReplaced: (parts: readonly string[]) => string;
};

const TEXT = {
  en: {
    extensionKept: (name, extension) => `Can't change the extension ${extension} of ${name}: the files that belong to it are named after it.`,
    partsGoAlong: (parts) => `${parts.length === 1 ? 'The file' : `The ${parts.length} files`} that belong to it will be deleted too: ${parts.join(', ')}.`,
    partsLeft: (parts) => `These files that belonged to it could not be deleted and are still in the folder: ${parts.join(', ')}.`,
    datasetSplit: (paths) => `The rename failed and could not be undone. The dataset's files are now at: ${paths.join(', ')}.`,
    sidecarTaken: (name, owner) => `${name} already exists: it belongs to ${owner} and is not listed in the tree.`,
    partsReplaced: (parts) => `Replacing also deletes ${parts.length === 1 ? 'this file' : 'these files'} of the old data: ${parts.join(', ')}.`,
  },
  'zh-CN': {
    extensionKept: (name, extension) => `无法更改 ${name} 的扩展名 ${extension}：它的附属文件以此命名。`,
    partsGoAlong: (parts) => `它的 ${parts.length} 个附属文件也会一并删除：${parts.join('、')}。`,
    partsLeft: (parts) => `以下附属文件无法删除，仍留在文件夹中：${parts.join('、')}。`,
    datasetSplit: (paths) => `重命名失败，且无法还原。这份数据的文件现位于：${paths.join('、')}。`,
    sidecarTaken: (name, owner) => `${name} 已存在：它是 ${owner} 的附属文件，不在文件树中显示。`,
    partsReplaced: (parts) => `替换时，旧数据的这些附属文件也会一并删除：${parts.join('、')}。`,
  },
  'zh-TW': {
    extensionKept: (name, extension) => `無法變更 ${name} 的副檔名 ${extension}：它的附屬檔案以此命名。`,
    partsGoAlong: (parts) => `它的 ${parts.length} 個附屬檔案也會一併刪除：${parts.join('、')}。`,
    partsLeft: (parts) => `以下附屬檔案無法刪除，仍留在資料夾中：${parts.join('、')}。`,
    datasetSplit: (paths) => `重新命名失敗，且無法還原。這份資料的檔案現位於：${paths.join('、')}。`,
    sidecarTaken: (name, owner) => `${name} 已存在：它是 ${owner} 的附屬檔案，不在檔案樹中顯示。`,
    partsReplaced: (parts) => `取代時，舊資料的這些附屬檔案也會一併刪除：${parts.join('、')}。`,
  },
} satisfies Record<'en' | 'zh-CN' | 'zh-TW', DatasetText>;

export const datasetText = (locale: Locale): DatasetText => (locale === 'zh-CN' || locale === 'zh-TW' ? TEXT[locale] : TEXT.en);
