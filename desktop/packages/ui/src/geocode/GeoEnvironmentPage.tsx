import React from 'react';

import { SETTINGS_CARD_GRID_CLASS, SettingsCard } from '@/components/sections/shared/SettingsCards';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useI18n } from '@/lib/i18n';
import { BasemapDetails } from './BasemapDetails';
import { BasemapLogo } from './BasemapLogo';
import { basemapLineOf, basemapText } from './basemapText';
import { GeeDetails } from './GeeDetails';
import { GeeLogo } from './GeeLogo';
import { geeText } from './geeText';
import { useGeoStatuses } from './geoEngineClient';
import { useGeoSettingsStore } from './geoSettingsStore';
import { basemapStatusOf, geeStatusOf, lightOf, qgisStatusOf, type BasemapStatus, type Light, type QgisView } from './geoStatus';
import { LightPill, QgisDetails } from './QgisDetails';
import { QgisLogo } from './QgisLogo';
import { qgisText, releaseOf, type QgisText } from './qgisText';
import { GEO_ENVIRONMENT_SEARCH_ITEM } from './settings';

/** An overview card's last line, a line tall even when empty, so a card keeps its height through every state. */
const CardLine: React.FC<{ children?: string }> = ({ children }) => (
  <span className="block h-lh min-w-0 truncate">{children}</span>
);

/** The QGIS a card names: its release and how many algorithms it offers, once it is ready. */
const qgisLineOf = (status: QgisView | undefined, text: QgisText) =>
  status?.status === 'ready' ? `${releaseOf(status.versions.qgis)} · ${text.algorithms(status.algorithms)}` : undefined;

/** A basemap that cannot be drawn as chosen: a block written wrong, or the offline one without its files. */
const basemapLightOf = (status: BasemapStatus | undefined): Light | undefined =>
  status && (status.invalid !== undefined || (status.source === 'offline' && !status.available)) ? 'failed' : undefined;

export const GeoEnvironmentPage: React.FC = () => {
  const { locale } = useI18n();
  const text = qgisText(locale);
  const requested = useGeoSettingsStore((state) => state.requested);
  // The page's own: leaving it ends on the overview next time.
  const [open, setOpen] = React.useState(requested);
  const statuses = useGeoStatuses();
  const status = React.useMemo(() => qgisStatusOf(statuses), [statuses]);
  const gee = React.useMemo(() => geeStatusOf(statuses), [statuses]);

  React.useEffect(() => {
    if (requested === null) return;
    setOpen(requested);
    useGeoSettingsStore.getState().request(null);
  }, [requested]);

  if (open === 'qgis') {
    return <QgisDetails status={status} revision={statuses.qgis?.revision ?? -1} onBack={() => setOpen(null)} />;
  }
  if (open === 'basemap') return <BasemapDetails onBack={() => setOpen(null)} />;
  if (open === 'gee') {
    return (
      <GeeDetails
        text={geeText(locale)}
        shared={text}
        status={gee}
        revision={statuses.gee?.revision ?? -1}
        onBack={() => setOpen(null)}
      />
    );
  }

  const qgisLight = status ? lightOf(status.status) : undefined;
  const geeLight = gee ? lightOf(gee.status) : undefined;
  const basemap = basemapStatusOf(statuses);
  const basemapWords = basemapText(locale);

  // Every card has a description and a last line whatever its state, so a change of state moves nothing on the page.
  return (
    <SettingsPageLayout title={text.pageTitle} description={text.pageDescription}>
      <div className={SETTINGS_CARD_GRID_CLASS} data-settings-item={GEO_ENVIRONMENT_SEARCH_ITEM.id}>
        <SettingsCard
          icon={<QgisLogo className="size-5" />}
          title="QGIS"
          description={text.cardDescription}
          badges={<LightPill light={qgisLight} text={text} />}
          footer={<CardLine>{qgisLineOf(status, text)}</CardLine>}
          muted={qgisLight === 'idle'}
          onOpen={() => setOpen('qgis')}
        />
        <SettingsCard
          icon={<GeeLogo className="size-5" />}
          title="Google Earth Engine"
          description={geeText(locale).cardDescription}
          badges={<LightPill light={geeLight} text={text} />}
          footer={<CardLine />}
          muted={geeLight === 'idle'}
          onOpen={() => setOpen('gee')}
        />
        <SettingsCard
          icon={<BasemapLogo className="size-5" />}
          title={basemapWords.title}
          description={basemapWords.cardDescription}
          badges={<LightPill light={basemapLightOf(basemap)} text={text} />}
          footer={<CardLine>{basemapLineOf(basemap, basemapWords)}</CardLine>}
          onOpen={() => setOpen('basemap')}
        />
      </div>
    </SettingsPageLayout>
  );
};
