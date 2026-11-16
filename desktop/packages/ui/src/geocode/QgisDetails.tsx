import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
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
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn, getRevealLabelKey } from '@/lib/utils';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useUIStore } from '@/stores/useUIStore';
import { chooseQgis, fetchQgisInstalls, pickQgisApp, recheckQgis, type QgisInstall } from './geoEngineClient';
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
        <Uses ready={light === 'ready'} text={text} />
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

/** The tool permissions are each agent's own; GeoAgent's are the ones that matter for the geo tools. */
const openPermissions = () => {
  useAgentsStore.getState().setSelectedAgent('geoagent');
  useUIStore.getState().requestSettingsJump('agents', 'agents.permissions');
};

const installTone = (light: Light | undefined): SettingsCardTone =>
  light === 'failed' ? 'error' : light === 'checking' ? 'warning' : light === 'ready' ? 'success' : 'neutral';

const TINT = {
  ready: 'var(--status-success)',
  checking: 'var(--status-warning)',
  failed: 'var(--status-error)',
  idle: 'var(--muted-foreground)',
} satisfies Record<Light, string>;

/** Contour lines drawn behind the overview's right side; decoration only. */
const CONTOURS = [0, 1, 2, 3, 4, 5, 6].map(
  (i) => `M${40 - i * 4} ${200 - i * 6} C ${70 + i * 6} ${150 - i * 14}, ${110 + i * 4} ${170 - i * 18}, ${150 + i * 2} ${120 - i * 12} S ${230 - i * 3} ${60 - i * 6}, 300 ${50 - i * 9}`,
);

const Contours: React.FC<{ light: Light }> = ({ light }) => (
  <div
    aria-hidden
    className="pointer-events-none absolute inset-y-0 end-0 w-[62%] overflow-hidden [mask-image:linear-gradient(to_left,#000_35%,transparent)]"
  >
    <svg
      viewBox="0 0 300 220"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      className={cn('absolute -end-9 -top-11 h-[230px] w-[320px]', light === 'idle' ? 'opacity-20' : 'opacity-50')}
      style={{ color: TINT[light] }}
    >
      {CONTOURS.map((d, i) => <path key={d} d={d} opacity={1 - i * 0.11} />)}
      {[0, 1, 2].map((i) => (
        <ellipse key={i} cx="225" cy="95" rx={26 + i * 18} ry={16 + i * 12} transform="rotate(-18 225 95)" opacity={0.9 - i * 0.25} />
      ))}
    </svg>
  </div>
);

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
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={unset ? undefined : { background: `radial-gradient(90% 120% at 0% 0%, color-mix(in srgb, ${TINT[light]} 9%, transparent), transparent 60%)` }}
        />
        <Contours light={light} />
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

type Mark = 'done' | 'failed' | 'busy' | 'waiting' | 'skipped';

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

const DOT_CLASS = {
  done: 'border-[var(--status-success)] bg-[var(--status-success)] text-white',
  failed: 'border-[var(--status-error)] bg-[var(--status-error)] text-white',
  busy: 'border-[var(--status-warning)] bg-[var(--surface-background)] text-[var(--status-warning)]',
  waiting: 'border-[var(--interactive-border-hover)] bg-[var(--surface-background)] text-muted-foreground',
  skipped: 'border-dashed border-[var(--interactive-border-hover)] bg-[var(--surface-background)] text-muted-foreground',
} satisfies Record<Mark, string>;

/** The check as GeoEngine makes it, step by step, with what it found or why it stopped on the line under it. */
const Check: React.FC<{ status: QgisView | undefined; text: QgisText }> = ({ status, text }) => {
  const steps = stepsOf(status, text);
  const blink = useWaitingBlink(status?.status === 'checking');
  // How far along the line is green: up to the last step passed, or to the one that failed.
  const reached = steps.reduce((last, step, i) => (step.mark === 'done' || step.mark === 'failed' ? i : last), 0);
  const share = `${(reached / (steps.length - 1)) * 100}%`;

  return (
    <div className="rounded-xl border border-[var(--interactive-border)] px-4 pb-3 pt-4">
      <ol className="relative grid grid-cols-1 @xl:grid-cols-6">
        {/* The line through the dots: down their centres in a column, across them in a row. */}
        <span aria-hidden className="absolute start-[12px] top-[19px] bottom-[19px] w-0.5 bg-[var(--interactive-border-hover)] @xl:hidden">
          <span className="absolute inset-x-0 top-0 bg-[var(--status-success)]" style={{ height: share }} />
        </span>
        <span aria-hidden className="absolute start-[8.333%] end-[8.333%] top-[12px] hidden h-0.5 bg-[var(--interactive-border-hover)] @xl:block">
          <span className="absolute inset-y-0 start-0 bg-[var(--status-success)]" style={{ width: share }} />
        </span>
        {steps.map((step, i) => (
          <li
            key={text.steps[i]}
            className="relative grid grid-cols-[26px_1fr_auto] items-center gap-2.5 py-1.5 @xl:flex @xl:flex-col @xl:items-center @xl:gap-0 @xl:py-0 @xl:text-center"
          >
            <span className={cn('z-10 flex size-[26px] items-center justify-center rounded-full border-2 text-[11px] font-semibold', DOT_CLASS[step.mark], step.mark === 'busy' && blink)}>
              {step.mark === 'done' ? <Icon name="check" className="size-3.5" /> : step.mark === 'failed' ? <Icon name="close" className="size-3.5" /> : i + 1}
            </span>
            <span
              className={cn(
                'typography-micro h-[18px] truncate font-semibold leading-[18px] @xl:mt-2',
                step.mark === 'failed' ? 'text-[var(--status-error)]' : step.mark === 'skipped' || step.mark === 'waiting' ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {text.steps[i]}
            </span>
            <span className="h-4 max-w-full truncate text-[11px] leading-4 text-muted-foreground @xl:mt-0.5" title={step.detail}>{step.detail}</span>
          </li>
        ))}
      </ol>
      <Verdict status={status} text={text} />
    </div>
  );
};

/** The check's outcome in a line of the interface's language, two lines' room whatever it says. */
const Verdict: React.FC<{ status: QgisView | undefined; text: QgisText }> = ({ status, text }) => {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const shown = status?.status ?? 'unconfigured';
  const fault = shown === 'ready' || shown === 'checking' || shown === 'unconfigured' ? undefined : shown;
  const icon: { name: IconName; className: string } = fault
    ? { name: 'error-warning', className: 'text-[var(--status-error)]' }
    : shown === 'ready'
      ? { name: 'checkbox-circle', className: 'text-[var(--status-success)]' }
      : shown === 'checking'
        ? { name: 'loader-4', className: 'animate-spin text-[var(--status-warning)]' }
        : { name: 'information', className: 'text-muted-foreground' };
  const line = fault ? text.explain[fault] : shown === 'ready' ? text.verdicts.ready : shown === 'checking' ? text.verdicts.checking : text.verdicts.idle;
  const diagnostics = status && fault ? diagnosticsOf(status) : '';

  return (
    <>
      <div className="mt-4 flex h-[51px] items-center gap-2.5 border-t border-[var(--interactive-border)] pt-3">
        <Icon name={icon.name} className={cn('size-[18px] shrink-0', icon.className)} aria-hidden />
        <p className="typography-meta line-clamp-2 min-w-0 flex-1 text-foreground">{line}</p>
        {fault ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="xs" className="text-muted-foreground" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
              {text.details}
            </Button>
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => { void copyTextToClipboard(diagnostics).then((outcome) => setCopied(outcome.ok)); }}>
              {copied ? text.copied : text.copy}
            </Button>
          </div>
        ) : null}
      </div>
      {fault && expanded ? (
        <pre className="typography-micro mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--surface-muted)] p-2 font-mono text-foreground">{diagnostics}</pre>
      ) : null}
    </>
  );
};

const USES = [
  { key: 'read', icon: 'file-search', tool: 'readgeodata' },
  { key: 'lookup', icon: 'book-open', tool: 'qgisdoc' },
  { key: 'run', icon: 'play', tool: 'qgisrun' },
] as const;

/** What the agent does with QGIS, one tile for each of its tools, faded while QGIS cannot be used. */
const Uses: React.FC<{ ready: boolean; text: QgisText }> = ({ ready, text }) => (
  <div className="grid grid-cols-1 gap-2.5 @xl:grid-cols-3">
    {USES.map((use) => (
      <div key={use.key} title={use.tool} className={cn('oc-tile min-w-0 rounded-xl p-3.5 transition-opacity', !ready && 'opacity-55')}>
        <div className="flex items-center gap-2.5">
          <span className="oc-tile-inset flex size-8 shrink-0 items-center justify-center rounded-[9px] text-[var(--status-success)]">
            <Icon name={use.icon} className="size-[17px]" />
          </span>
          <span className="typography-ui-label truncate font-semibold text-foreground">{text.uses[use.key].name}</span>
        </div>
        <p className="typography-micro mt-2 truncate text-muted-foreground">{text.uses[use.key].text}</p>
      </div>
    ))}
  </div>
);

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
