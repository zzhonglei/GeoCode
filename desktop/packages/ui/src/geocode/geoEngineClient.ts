import React from 'react';
import { z } from 'zod';

import { getDesktopBridge } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  geoStatusSnapshotSchema,
  NO_GEO_STATUSES,
  withGeoStatusEvent,
  withGeoStatusSnapshot,
  type GeoStatuses,
} from './geoStatus';

// The shell server's routes for GeoEngine, see web/server/geocode/geoengine.js.
const SNAPSHOT_PATH = '/api/geocode/geo-status';
const QGIS_PATH = '/api/geocode/qgis';

const refusalSchema = z.object({ error: z.string() });

const installsSchema = z.object({
  installs: z.array(z.object({ app: z.string(), version: z.string().optional() })),
});

const doneSchema = z.object({});

export type QgisInstall = z.infer<typeof installsSchema>['installs'][number];

/** A refusal or a lost connection carries the reason to show; it is never read as an empty answer. */
type Outcome<T> ={ ok: true; value: T } | { ok: false; reason: string };

const request = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<Outcome<T>> => {
  const response = await runtimeFetch(path, init).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in response) return { ok: false, reason: response.error };
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const refusal = refusalSchema.safeParse(body);
    return { ok: false, reason: refusal.success ? refusal.data.error : `GeoEngine request failed (${response.status})` };
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'GeoEngine answered in a form this interface cannot read' };
};

export const useGeoStatuses = (): GeoStatuses => {
  const [statuses, setStatuses] = React.useState(NO_GEO_STATUSES);

  React.useEffect(() => {
    let active = true;
    const read = () => {
      void request(SNAPSHOT_PATH, geoStatusSnapshotSchema).then((outcome) => {
        if (!outcome.ok) {
          console.warn('[geocode] could not read the GeoEngine statuses:', outcome.reason);
          return;
        }
        if (active) setStatuses((current) => withGeoStatusSnapshot(current, outcome.value));
      });
    };
    // Subscribed before the first read, so no change slips between them; changes sent while the stream was down are
    // lost, hence a read on every reconnect.
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'geo-status') setStatuses((current) => withGeoStatusEvent(current, event));
      if (event.type === 'event-stream-ready') read();
    });
    read();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return statuses;
};

export const fetchQgisInstalls = async (): Promise<Outcome<QgisInstall[]>> => {
  const outcome = await request(`${QGIS_PATH}/installs`, installsSchema);
  return outcome.ok ? { ok: true, value: outcome.value.installs } : outcome;
};

/** GeoEngine writes the choice to machine.json and checks it; the outcome of the check arrives as a status. */
export const chooseQgis = (path: string) => request(QGIS_PATH, doneSchema, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path }),
});

export const recheckQgis = () => request(`${QGIS_PATH}/recheck`, doneSchema, { method: 'POST' });

const pickedSchema = z.string().min(1);

/**
 * The QGIS the user picks in the system's file dialog: its app on macOS, its folder on Windows, where GeoEngine finds
 * the QGIS anywhere inside one; null when they cancel or there is no dialog.
 */
export const pickQgisApp = async (titles: { app: string; folder: string }): Promise<string | null> => {
  const windows = window.__OPENCHAMBER_PLATFORM__ === 'win32';
  const picked = pickedSchema.safeParse(await getDesktopBridge()?.openDialog?.(windows
    ? { title: titles.folder, directory: true, multiple: false, defaultPath: 'C:\\Program Files' }
    : {
      title: titles.app,
      directory: false,
      multiple: false,
      defaultPath: '/Applications',
      filters: [{ name: 'QGIS', extensions: ['app'] }],
    }));
  return picked.success ? picked.data : null;
};
