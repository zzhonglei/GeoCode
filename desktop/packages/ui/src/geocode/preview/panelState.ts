import { create } from 'zustand';

import type { ToolbarAction } from '@/components/ui/action-toolbar';
import { useI18n } from '@/lib/i18n';
import { isGeoDataFile } from './geoFiles';
import { previewText } from './previewText';

/**
 * Whether the panel of a geographic file's preview is open, by the file's path: the files view's toolbar opens and
 * closes it, and the preview shows it and opens it on a click on the map.
 */
export const usePanelStore = create<{ open: Readonly<Record<string, boolean>>; setOpen: (path: string, open: boolean) => void }>()((set) => ({
  open: {},
  setOpen: (path, open) => set((state) => ({ open: { ...state.open, [path]: open } })),
}));

/** The files view's toolbar button that opens and closes the panel of the geographic file shown; none for another file. */
export const useGeoPanelAction = (path: string | null | undefined): ToolbarAction | null => {
  const { locale } = useI18n();
  const open = usePanelStore((state) => (path ? state.open[path] === true : false));
  const setOpen = usePanelStore((state) => state.setOpen);
  if (!path || !isGeoDataFile(path)) return null;
  return { id: 'geo-panel', label: previewText(locale).panel, icon: 'survey', pressed: open, onSelect: () => setOpen(path, !open), pinned: true };
};
