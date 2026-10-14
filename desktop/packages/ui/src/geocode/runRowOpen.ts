import { create } from 'zustand';

// A store rather than component state: the row moves between groups as the turn goes on, and stays open.
const useExpanded = create<{
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
}>()((set) => ({
  open: new Set(),
  toggle: (id) =>
    set((state) => {
      const open = new Set(state.open);
      if (!open.delete(id)) open.add(id);
      return { open };
    }),
}));

export const useRunRowOpen = (id: string) => useExpanded((state) => state.open.has(id));

export const useRunRowToggle = () => useExpanded((state) => state.toggle);
