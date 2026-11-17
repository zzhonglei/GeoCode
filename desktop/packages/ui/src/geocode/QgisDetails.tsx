import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsBackButton,
  SettingsCard,
  SettingsCardPill,
  type SettingsCardTone,
} from '@/components/sections/shared/SettingsCards';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn, getRevealLabelKey } from '@/lib/utils';
import { CheckFrame, CheckSteps, OverviewBackdrop, Uses, Verdict, type StepMark, type Use } from './GeoDetailsParts';
import { chooseQgis, fetchQgisInstalls, pickQgisApp, recheckQgis, type QgisInstall } from './geoEngineClient';
import { openPermissions } from './geoSettingsStore';
import { lightOf, type Light, type QgisView } from './geoStatus';
import { QgisLogo } from './QgisLogo';
import { codenameOf, diagnosticsOf, qgisText, releaseOf, type QgisText } from './qgisText';
import { TONE } from './settingsList';

const DOWNLOAD = 'https://qgis.org/download/';

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

/** A pill naming one of the four lights; what is wrong is said in the check below, not on the pill. */
export const LightPill: React.FC<{ light: Light | undefined; text: QgisText }> = ({ light, text }) => (
  light ? <SettingsCardPill tone={TONE[light]}>{text.lights[light]}</SettingsCardPill> : null
);

/** The QGIS settings page: what is in use and how it is, its check, what GeoCode uses it for, and every QGIS found. */
export const QgisDetails: React.FC<{ status: QgisView | undefined; revision: number; onBack: () => void }> = ({ status, revision, onBack }) => {
  const { locale } = useI18n();
  const text = qgisText(locale);
  const [installs, setInstalls] = React.useState<Installs>({ kind: 'loading' });
  const [pending, setPending] = React.useState<Pending | null>(null);
  const revisionRef = React.useRef(revision);
  revisionRef.current = revision;
  const configured = configuredOf(status);
  const isConfigured = (app: string) => app === configured.path || app === configured.app;
  const isChosen = (app: string) => (pending ? app === pending.app : isConfigured(app));
  const light = status ? lightOf(status.status) : undefined;
  // GeoEngine refuses to write over a file it cannot read; the check below names the file and where it breaks.
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
  // The release the scan found for the configured QGIS, for a status that does not carry one.
  const listedVersion = listed.find((install) => isConfigured(install.app))?.version;

  // Every part keeps its place and height whatever the state: a failure changes colours and words, never the layout.
  return (
    <SettingsPageLayout
      title="QGIS"
      titleLeading={<SettingsBackButton label={text.back} onClick={onBack} />}
      titleAccessory={<LightPill light={light} text={text} />}
    >
      <SettingsSection divider={false} settingsItem="geo-environment.qgis">
        <Overview status={status} listedVersion={listedVersion} text={text} onRecheck={recheck} />
      </SettingsSection>
      <SettingsSection title={text.checkHeading} description={text.checkDescription}>
        <Check status={status} text={text} />
      </SettingsSection>
      <SettingsSection
        title={text.usesHeading}
        headerAction={(
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={openPermissions}>
            {text.permissions}
            <Icon name="arrow-right" className="size-3.5" />
          </Button>
        )}
      >
        <Uses uses={usesOf(text)} ready={light === 'ready'} colour="var(--status-success)" />
      </SettingsSection>
      <SettingsSection
        title={text.installsHeading}
        description={installs.kind === 'found' ? text.found(listed.length) : installs.kind === 'loading' ? text.scanning : text.scanFailed(installs.reason)}
        headerAction={(
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
        )}
      >
        {installs.kind === 'found' && listed.length === 0 ? (
          <Nothing text={text} locked={locked} onChoose={() => void chooseElsewhere()} />
        ) : (
          <div className={SETTINGS_CARD_GRID_CLASS}>
            {listed.map((install) => (
              <SettingsCard
                key={install.app}
                icon={<QgisLogo className="size-5" />}
                title={install.version ? `QGIS ${install.version}` : 'QGIS'}
                subtitle={install.app}
                badges={isChosen(install.app) ? (
                  <SettingsCardPill tone={pending ? 'neutral' : installTone(light)}>{text.inUse}</SettingsCardPill>
                ) : null}
                // As tall as the arrow a card that can be chosen shows, so a locked card keeps its height.
                footer={<span aria-hidden className="h-4" />}
                muted={locked}
                onOpen={locked ? undefined : () => choose(install.app)}
              />
            ))}
            <div className={cn('grid', locked && 'pointer-events-none opacity-60')} aria-disabled={locked || undefined}>
              <SettingsAddCard label={text.chooseOther} onClick={() => void chooseElsewhere()} />
            </div>
          </div>
        )}
      </SettingsSection>
    </SettingsPageLayout>
  );
};

const installTone = (light: Light | undefined): SettingsCardTone =>
  light === 'failed' ? 'error' : light === 'checking' ? 'warning' : light === 'ready' ? 'success' : 'neutral';

/** Where the overview's second line points: the QGIS in use, or the settings file when that cannot be read. */
const locationOf = (status: QgisView | undefined) => {
  if (!status || status.status === 'unconfigured' || status.status === 'unreadable') return undefined;
  if (status.status === 'ready') return status.app;
  if (status.status === 'checking') return status.path;
  return status.diagnostics.file ?? status.diagnostics.app ?? status.diagnostics.path;
};

/** The QGIS in use, named by its release and its release's name, its location, and three facts once it is ready. */
const Overview: React.FC<{ status: QgisView | undefined; listedVersion: string | undefined; text: QgisText; onRecheck: () => void }> = ({
  status,
  listedVersion,
  text,
  onRecheck,
}) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const light = status ? lightOf(status.status) : 'idle';
  const unset = !status || status.status === 'unconfigured';
  const ready = status?.status === 'ready' ? status : undefined;
  const version = ready
    ? releaseOf(ready.versions.qgis)
    : (status && 'diagnostics' in status ? status.diagnostics.version : undefined) ?? listedVersion;
  const codename = ready ? codenameOf(ready.versions.qgis) : undefined;
  const location = locationOf(status);
  const reveal = status?.status === 'path-missing' ? undefined : files.revealPath;
  const showLocation = (path: string) => {
    // Revealing a folder opens it, and an app bundle is a folder that opens as the app: show the folder it is in.
    const target = /\.app$/i.test(path) ? path.replace(/[\\/][^\\/]*$/, '') : path;
    void reveal?.(target).catch(() => toast.error(t('sidebarFilesTree.toast.revealFailed')));
  };

  return (
    <div className="oc-tile overflow-hidden rounded-xl">
      <div className="relative overflow-hidden">
        <OverviewBackdrop light={light} ready="var(--status-success)" texture="contours" />
        <div className="relative flex items-center gap-3.5 p-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-background)] ring-1 ring-[var(--interactive-border)] ring-inset">
            <QgisLogo className={cn('size-[26px]', unset && 'opacity-45 grayscale')} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex h-6 min-w-0 items-baseline gap-2">
              <span className="truncate text-[17px] font-semibold leading-6 tracking-[-0.01em] text-foreground">
                {unset ? text.notChosen : version ? `QGIS ${version}` : 'QGIS'}
              </span>
              {codename ? <span className="typography-meta shrink-0 text-muted-foreground">{codename}</span> : null}
            </div>
            {unset || !location ? (
              <p className="typography-micro mt-0.5 h-5 truncate leading-5 text-muted-foreground">{unset ? text.notChosenText : null}</p>
            ) : reveal ? (
              <button
                type="button"
                onClick={() => showLocation(location)}
                title={t(getRevealLabelKey())}
                className="group typography-micro mt-0.5 flex h-5 max-w-full items-center gap-1.5 leading-5 text-muted-foreground hover:text-foreground"
              >
                <span className="truncate group-hover:underline group-hover:underline-offset-2">{location}</span>
                <Icon name="folder-received" className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-80" aria-hidden />
              </button>
            ) : (
              <p className="typography-micro mt-0.5 h-5 truncate leading-5 text-muted-foreground" title={location}>{location}</p>
            )}
          </div>
          {/* Kept in place while there is nothing to check, so choosing a QGIS moves nothing. */}
          <Button
            variant="ghost"
            size="xs"
            className={cn('shrink-0 text-muted-foreground', unset && 'invisible')}
            disabled={status?.status === 'checking'}
            onClick={onRecheck}
          >
            <Icon name="refresh" className="size-3.5" />
            {text.recheck}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-3 border-t border-[var(--interactive-border)]">
        <Fact value={ready ? String(ready.algorithms) : undefined} label={text.algorithmsLabel} />
        <Fact value={ready?.versions.gdal} label="GDAL" />
        <Fact value={ready?.versions.python} label="Python" />
      </div>
    </div>
  );
};

const Fact: React.FC<{ value: string | undefined; label: string }> = ({ value, label }) => (
  <div className="min-w-0 px-4 py-3 [&+&]:border-s [&+&]:border-[var(--interactive-border)]">
    <div className={cn('h-[22px] truncate text-base leading-[22px]', value ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
      {value ?? '—'}
    </div>
    <div className="typography-micro h-4 truncate leading-4 text-muted-foreground">{label}</div>
  </div>
);

type Mark = Extract<StepMark, 'done' | 'failed' | 'busy' | 'waiting' | 'skipped'>;

/** The step a failure stops at, in the check's order: the app, Python, GDAL, the transform, QGIS's core, Processing. */
const stopOf = (status: QgisView['status']): number | undefined => {
  switch (status) {
    case 'platform-unsupported':
    case 'path-missing':
    case 'not-qgis':
    case 'ambiguous':
      return 0;
    case 'python-missing':
      return 1;
    case 'gdal-missing':
      return 2;
    case 'proj-broken':
      return 3;
    case 'core-missing':
      return 4;
    case 'processing-failed':
      return 5;
    default:
      return undefined;
  }
};

/** Each step's mark and the word under it. A check reports only when it ends, so while it runs every step waits alike. */
const stepsOf = (status: QgisView | undefined, text: QgisText): { mark: Mark; detail: string }[] => {
  const ready = status?.status === 'ready' ? status : undefined;
  const app = locationOf(status)?.split(/[\\/]/).pop() ?? '';
  const passed = ready
    ? [app, ready.versions.python, ready.versions.gdal, text.stepWorks, releaseOf(ready.versions.qgis), String(ready.algorithms)]
    : [app, '', '', '', '', ''];
  const stop = status ? stopOf(status.status) : undefined;
  return passed.map((detail, i) => {
    if (ready) return { mark: 'done', detail };
    if (!status || status.status === 'unconfigured') return { mark: 'waiting', detail: '' };
    if (status.status === 'checking') return { mark: 'busy', detail: text.stepWaiting };
    if (stop === undefined || i > stop) return { mark: 'skipped', detail: text.stepNotRun };
    return i < stop ? { mark: 'done', detail } : { mark: 'failed', detail: text.stepFailed };
  });
};

/** The check as GeoEngine makes it, step by step, with what it found or why it stopped on the line under it. */
const Check: React.FC<{ status: QgisView | undefined; text: QgisText }> = ({ status, text }) => {
  const steps = stepsOf(status, text).map((step, i) => ({ ...step, name: text.steps[i] }));
  const shown = status?.status ?? 'unconfigured';
  const fault = shown === 'ready' || shown === 'checking' || shown === 'unconfigured' ? undefined : shown;
  const kind = fault ? 'failed' : shown === 'ready' ? 'ready' : shown === 'checking' ? 'checking' : 'idle';
  const line = fault ? text.explain[fault] : shown === 'ready' ? text.verdicts.ready : shown === 'checking' ? text.verdicts.checking : text.verdicts.idle;
  return (
    <CheckFrame>
      <CheckSteps steps={steps} columns={6} />
      <Verdict kind={kind} line={line} diagnostics={status && fault ? diagnosticsOf(status) : ''} text={text} />
    </CheckFrame>
  );
};

/** What the agent does with QGIS, one tile for each of its tools. */
const usesOf = (text: QgisText): Use[] => [
  { key: 'read', icon: 'file-search', tool: 'readgeodata', ...text.uses.read },
  { key: 'lookup', icon: 'book-open', tool: 'qgisdoc', ...text.uses.lookup },
  { key: 'run', icon: 'play', tool: 'qgisrun', ...text.uses.run },
];

/** No QGIS on this computer: as tall as a row of cards, with the way to get one and the way to choose one elsewhere. */
const Nothing: React.FC<{ text: QgisText; locked: boolean; onChoose: () => void }> = ({ text, locked, onChoose }) => (
  <div className="flex min-h-[132px] items-center gap-4 rounded-xl border border-dashed border-[color-mix(in_srgb,var(--foreground)_14%,transparent)] px-5 py-4">
    <span className="oc-tile-inset flex size-11 shrink-0 items-center justify-center rounded-xl">
      <QgisLogo className="size-6 opacity-50 grayscale" />
    </span>
    <div className="min-w-0 flex-1">
      <p className="typography-ui-label font-semibold text-foreground">{text.nothingTitle}</p>
      <p className="typography-micro mt-1 line-clamp-2 text-muted-foreground">{text.nothingText}</p>
    </div>
    <div className="flex shrink-0 flex-wrap justify-end gap-2">
      <Button variant="outline" size="xs" onClick={() => { void openExternalUrl(DOWNLOAD); }}>
        {text.download}
        <Icon name="external-link" className="size-3.5" />
      </Button>
      <Button variant="outline" size="xs" disabled={locked} onClick={onChoose}>{text.chooseOther}</Button>
    </div>
  </div>
);
