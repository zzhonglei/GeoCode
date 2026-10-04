import { create } from 'zustand';

type GeoDomain = 'qgis';

type GeoSettingsState = {
  /** An environment whose details the Geo environment page should open; the page takes it and clears it. */
  requested: GeoDomain | null;
  request: (domain: GeoDomain | null) => void;
};

// Outside the page, so the QGIS indicator can ask for its details before the page mounts.
export const useGeoSettingsStore = create<GeoSettingsState>()((set) => ({
  requested: null,
  request: (requested) => set({ requested }),
}));
