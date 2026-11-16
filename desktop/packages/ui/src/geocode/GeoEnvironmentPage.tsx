import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsBackButton,
  SettingsCard,
  SettingsCardPill,
  type SettingsCardTone,
} from '@/components/sections/shared/SettingsCards';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_HELPER_CLASS, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BasemapDetails } from './BasemapDetails';
import { BasemapLogo } from './BasemapLogo';
import { basemapLineOf, basemapText } from './basemapText';
import { GeeDetails } from './GeeDetails';
import { GeeLogo } from './GeeLogo';
import { geeText } from './geeText';
import { chooseQgis, fetchQgisInstalls, pickQgisApp, recheckQgis, useGeoStatuses, type QgisInstall } from './geoEngineClient';
import { useGeoSettingsStore } from './geoSettingsStore';
import { basemapStatusOf, geeStatusOf, lightOf, qgisStatusOf, type BasemapStatus, type Light, type QgisView } from './geoStatus';
import { QgisLogo } from './QgisLogo';
import { QgisStatusDetails } from './QgisStatusDetails';
import { QGIS_STATUS, qgisText, releaseOf, type QgisText } from './qgisText';
import { GEO_ENVIRONMENT_SEARCH_ITEM } from './settings';
import { LIST_CLASS, ROW_CLASS, TONE } from './settingsList';

type Installs = { kind: 'loading' } | { kind: 'found'; installs: QgisInstall[] } | { kind: 'failed'; reason: string };

/** A choice shown as made until a status after its write arrives; `after` is the revision held when the write landed. */
type Pending = { app: string; after: number | null };

/**
 * The QGIS the configuration names, as far as the status tells: the path as written while checking, the app it resolves
 * to once ready, and both on a failure. An install matches either.
 */
interface Configured {
  readonly path?: string;
  readonly app?: string;
}

const configuredOf = (status: QgisView | undefined): Configured => {
  if (!status || status.status === 'unconfigured' || status.status === 'unreadable') return {};
  if (status.status === 'checking') return { path: status.path };
  if (status.status === 'ready') return { app: status.app };
  return { path: status.diagnostics.path, app: status.diagnostics.app };
};

const StatusPill: React.FC<{ status: QgisView | undefined }> = ({ status }) => (
  status ? <SettingsCardPill tone={TONE[lightOf(status.status)]}>{QGIS_STATUS[status.status]}</SettingsCardPill> : null
);

/** An overview card's pill: one word for the light, as what is wrong is said on the environment's own page. */
const LightPill: React.FC<{ light: Light | undefined; text: QgisText }> = ({ light, text }) => (
  light ? <SettingsCardPill tone={TONE[light]}>{text.lights[light]}</SettingsCardPill> : null
);

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
    return <QgisDetails text={text} status={status} revision={statuses.qgis?.revision ?? -1} onBack={() => setOpen(null)} />;
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

const QgisDetails: React.FC<{ text: QgisText; status: QgisView | undefined; revision: number; onBack: () => void }> = ({ text, status, revision, onBack }) => {
  const [installs, setInstalls] = React.useState<Installs>({ kind: 'loading' });
  const [pending, setPending] = React.useState<Pending | null>(null);
  const revisionRef = React.useRef(revision);
  revisionRef.current = revision;
  const configured = configuredOf(status);
  const isConfigured = (app: string) => app === configured.path || app === configured.app;
  const isChosen = (app: string) => (pending ? app === pending.app : isConfigured(app));
  const light = status ? lightOf(status.status) : 'idle';
  // GeoEngine refuses to write over a file it cannot read; the diagnostics above name the file and where it breaks.
  const locked = status?.status === 'config-error';

  const scan = React.useCallback(() => {
    setInstalls({ kind: 'loading' });
    void fetchQgisInstalls().then((outcome) => {
      setInstalls(outcome.ok ? { kind: 'found', installs: outcome.value } : { kind: 'failed', reason: outcome.reason });
    });
  }, []);

  React.useEffect(scan, [scan]);

  // Whatever the configuration names once a later status arrives wins, even if it is not this choice.
  React.useEffect(() => {
    if (!pending) return;
    if (pending.app === configured.path || pending.app === configured.app) setPending(null);
    if (pending.after !== null && revision > pending.after) setPending(null);
  }, [configured.app, configured.path, pending, revision]);

  const choose = (app: string) => {
    if (isChosen(app)) return;
    setPending({ app, after: null });
    void chooseQgis(app).then((outcome) => {
      if (outcome.ok) {
        setPending((current) => (current?.app === app ? { app, after: revisionRef.current } : current));
        return;
      }
      setPending((current) => (current?.app === app ? null : current));
      toast.error(text.chooseFailed(outcome.reason));
    });
  };

  const chooseElsewhere = async () => {
    const picked = await pickQgisApp({ app: text.pickTitle, folder: text.pickFolderTitle });
    if (picked) choose(picked);
  };

  const recheck = () => {
    void recheckQgis().then((outcome) => {
      if (!outcome.ok) toast.error(text.recheckFailed(outcome.reason));
    });
  };

  const listed = installs.kind === 'found' ? installs.installs : [];
  const shown = configured.app ?? configured.path;
  // The configured QGIS stays in the list when the scan does not find it, so a missing one is seen as missing.
  const rows: QgisInstall[] = shown && !listed.some((install) => isConfigured(install.app))
    ? [{
      app: shown,
      version: status?.status === 'ready' ? releaseOf(status.versions.qgis) : undefined,
    }, ...listed]
    : listed;

  return (
    <SettingsPageLayout
      title="QGIS"
      titleLeading={<SettingsBackButton label={text.back} onClick={onBack} />}
      titleAccessory={<StatusPill status={status} />}
      // A file that cannot be read is read again on a recheck, the way back once it is fixed.
      headerEnd={shown || locked ? (
        <Button variant="outline" size="xs" disabled={status?.status === 'checking'} onClick={recheck}>
          {text.recheck}
        </Button>
      ) : null}
    >
      {status && light === 'failed' ? (
        <div className="mb-6 border-s-2 border-[var(--status-error)] ps-3">
          <QgisStatusDetails status={status} text={text} withApp={false} />
        </div>
      ) : null}
      <SettingsSection
        divider={false}
        title={text.installsHeading}
        headerAction={(
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={locked} onClick={() => void chooseElsewhere()}>
              {text.chooseOther}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              disabled={installs.kind === 'loading'}
              onClick={scan}
              aria-label={text.rescan}
              title={text.rescan}
            >
              <Icon name="refresh" className={cn('size-4', installs.kind === 'loading' && 'animate-spin')} />
            </Button>
          </div>
        )}
        settingsItem="geo-environment.qgis"
      >
        {installs.kind === 'failed' ? (
          <p className="typography-meta mb-2 text-[var(--status-error)]">{text.scanFailed(installs.reason)}</p>
        ) : null}
        {installs.kind === 'found' && rows.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{text.none}</p> : null}
        {rows.length > 0 ? (
          <div role="radiogroup" aria-label={text.installsHeading} aria-disabled={locked || undefined} className={LIST_CLASS}>
            {rows.map((install) => (
              <InstallRow
                key={install.app}
                install={install}
                text={text}
                selected={isChosen(install.app)}
                tone={isChosen(install.app) && !pending ? TONE[light] : 'neutral'}
                locked={locked}
                onSelect={() => choose(install.app)}
              />
            ))}
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageLayout>
  );
};

const InstallRow: React.FC<{
  install: QgisInstall;
  text: QgisText;
  selected: boolean;
  tone: SettingsCardTone;
  locked: boolean;
  onSelect: () => void;
}> = ({ install, text, selected, tone, locked, onSelect }) => {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={locked || undefined}
      onClick={locked ? undefined : onSelect}
      className={cn(
        ROW_CLASS,
        selected ? 'bg-[var(--interactive-selection)]/25' : 'hover:bg-[var(--interactive-hover)]/50',
        locked && 'cursor-not-allowed opacity-60 hover:bg-transparent',
      )}
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-[var(--primary-base)]' : 'border-[var(--interactive-border-hover)]',
        )}
        aria-hidden
      >
        {selected ? <span className="size-2 rounded-full bg-[var(--primary-base)]" /> : null}
      </span>
      <span className="typography-ui-label shrink-0 font-medium text-foreground">{install.version ? `QGIS ${install.version}` : 'QGIS'}</span>
      <span className="typography-micro min-w-0 flex-1 truncate font-mono text-muted-foreground" title={install.app}>{install.app}</span>
      {selected ? <SettingsCardPill tone={tone}>{text.inUse}</SettingsCardPill> : null}
    </button>
  );
};
