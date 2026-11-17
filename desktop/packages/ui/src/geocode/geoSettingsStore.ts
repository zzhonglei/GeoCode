import { create } from 'zustand';

import { useAgentsStore } from '@/stores/useAgentsStore';
import { useUIStore } from '@/stores/useUIStore';

type GeoDomain = 'qgis' | 'gee' | 'basemap';

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

/** The tool permissions are each agent's own; GeoAgent's are the ones that matter for the geo tools. */
export const openPermissions = () => {
  useAgentsStore.getState().setSelectedAgent('geoagent');
  useUIStore.getState().requestSettingsJump('agents', 'agents.permissions');
};
