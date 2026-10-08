import { create } from 'zustand';

type GeoDomain = 'qgis' | 'gee';

type GeoSettingsState = {
  /** An environment whose details the Geo environment page should open; the page takes it and clears it. */
  requested: GeoDomain | null;
  request: (domain: GeoDomain | null) => void;
};

// Outside the page, so an indicator can ask for its environment's details before the page mounts.
export const useGeoSettingsStore = create<GeoSettingsState>()((set) => ({
  requested: null,
  request: (requested) => set({ requested }),
}));
