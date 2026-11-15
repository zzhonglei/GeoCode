import { toast } from '@/components/ui';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { invokeDesktop } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

import { useGeoStatuses } from './geoEngineClient';
import { qgisStatusOf } from './geoStatus';
import { isGeoDataFile } from './preview/geoFiles';

const QGIS_PROJECT = /\.qg[sz]$/i;

/**
 * Simple Icons "qgis" (CC0), fitted into the 24x24 box at a longer side of 20 as the other apps' marks are in
 * desktop/scripts/icons/open-in-apps.mjs; drawn here so the upstream sprite stays as it ships.
 */
const QgisMark = () => (
  <svg className="remixicon size-4" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g transform="translate(2 2) scale(0.8333)">
      <path
        fill="currentColor"
        d="M12.879 13.006v3.65l-3.004-3.048v-3.495h3.582l2.852 2.893h-3.43zm10.886 7.606V24h-3.654l-5.73-5.9v-3.55h3.354l6.03 6.062zm-10.828-1.448l3.372 3.371c-1.309.442-2.557.726-4.325.726C5.136 23.26 0 18.243 0 11.565 0 4.92 5.136 0 11.984 0 18.864 0 24 4.952 24 11.565c0 2.12-.523 4.076-1.457 5.759l-3.625-3.725a8.393 8.393 0 0 0 .24-2.005c0-4.291-3.148-7.527-7.1-7.527-3.954 0-7.248 3.236-7.248 7.527s3.33 7.6 7.247 7.6c.548 0 .661.017.88-.03z"
      />
    </g>
  </svg>
);

/**
 * The files view's Open In entry for the QGIS set up in Settings, beside the other apps: for geographic data and
 * QGIS projects, while that QGIS is ready. The main process opens the file in the QGIS GeoEngine reports.
 */
export const OpenInQgisItem = ({ path }: { path: string | undefined }) => {
  const { t } = useI18n();
  const ready = qgisStatusOf(useGeoStatuses())?.status === 'ready';
  if (!ready || !path || !(isGeoDataFile(path) || QGIS_PROJECT.test(path))) return null;
  return (
    <DropdownMenuItem
      className="flex items-center gap-2"
      onClick={() => {
        void invokeDesktop('geocode_open_in_qgis', { filePath: path }).catch(() => {
          toast.error(t('filesView.toast.openInAppFailed', { app: 'QGIS' }));
        });
      }}
    >
      <QgisMark />
      <span className="typography-ui-label text-foreground">QGIS</span>
    </DropdownMenuItem>
  );
};
