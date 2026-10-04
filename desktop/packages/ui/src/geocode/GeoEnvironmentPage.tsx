import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsBackButton, SettingsCardPill, type SettingsCardTone } from '@/components/sections/shared/SettingsCards';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_HELPER_CLASS, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { chooseQgis, fetchQgisInstalls, pickQgisApp, recheckQgis, useGeoStatuses, type QgisInstall } from './geoEngineClient';
import { useGeoSettingsStore } from './geoSettingsStore';
import { lightOf, qgisStatusOf, type Light, type QgisView } from './geoStatus';
import { QgisLogo } from './QgisLogo';
import { QgisStatusDetails } from './QgisStatusDetails';
import { qgisText, releaseOf, summaryOf, type QgisText } from './qgisText';

const TONE = {
  ready: 'success',
  checking: 'warning',
  idle: 'neutral',
  failed: 'error',
} satisfies Record<Light, SettingsCardTone>;

const LIST_CLASS = 'divide-y divide-[var(--interactive-border)] overflow-hidden rounded-lg border border-[var(--interactive-border)]';
const ROW_CLASS = 'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:bg-[var(--interactive-hover)]';

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

/** One line under a name: what runs when it is ready, what it is for otherwise. */
const lineOf = (status: QgisView | undefined, text: QgisText) =>
  status?.status === 'ready' ? summaryOf(status, text) : text.qgisDescription;

const StatusPill: React.FC<{ status: QgisView | undefined; text: QgisText }> = ({ status, text }) => (
  status ? <SettingsCardPill tone={TONE[lightOf(status.status)]}>{text.status[status.status]}</SettingsCardPill> : null
);

export const GeoEnvironmentPage: React.FC = () => {
  const { locale } = useI18n();
  const text = qgisText(locale);
  const requested = useGeoSettingsStore((state) => state.requested);
  // The page's own: leaving it ends on the overview next time.
  const [open, setOpen] = React.useState(requested);
  const statuses = useGeoStatuses();
  const status = React.useMemo(() => qgisStatusOf(statuses), [statuses]);

  React.useEffect(() => {
    if (requested === null) return;
    setOpen(requested);
    useGeoSettingsStore.getState().request(null);
  }, [requested]);

  if (open === 'qgis') {
    return <QgisDetails text={text} status={status} revision={statuses.qgis?.revision ?? -1} onBack={() => setOpen(null)} />;
  }

  return (
    <SettingsPageLayout title={text.pageTitle} description={text.pageDescription}>
      <div className={LIST_CLASS}>
        <button type="button" onClick={() => setOpen('qgis')} className={cn(ROW_CLASS, 'py-2.5 hover:bg-[var(--interactive-hover)]/50')}>
          <QgisLogo className="size-5 shrink-0" />
          <span className="typography-ui-label shrink-0 font-medium text-foreground">QGIS</span>
          <span className="typography-meta min-w-0 flex-1 truncate text-muted-foreground">{lineOf(status, text)}</span>
          <StatusPill status={status} text={text} />
          <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
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
  // GeoEngine refuses to write over a file it cannot read; the advice above says what to do instead.
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
    const picked = await pickQgisApp(text.pickTitle);
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
      supported: status?.status !== 'unsupported',
    }, ...listed]
    : listed;

  return (
    <SettingsPageLayout
      title="QGIS"
      titleLeading={<SettingsBackButton label={text.back} onClick={onBack} />}
      titleAccessory={<StatusPill status={status} text={text} />}
      description={lineOf(status, text)}
      headerEnd={shown ? (
        <Button variant="outline" size="xs" disabled={status?.status === 'checking'} onClick={recheck}>
          {text.recheck}
        </Button>
      ) : null}
    >
      {status && light === 'failed' ? (
        <div className="mb-6 border-l-2 border-[var(--status-error)] pl-3">
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
  // Kept focusable, so keyboard and screen reader users still reach why it cannot be chosen.
  const unavailable = locked || !install.supported;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={unavailable || undefined}
      title={install.supported ? undefined : text.oldReleaseHint}
      onClick={unavailable ? undefined : onSelect}
      className={cn(
        ROW_CLASS,
        selected ? 'bg-[var(--interactive-selection)]/25' : 'hover:bg-[var(--interactive-hover)]/50',
        unavailable && 'cursor-not-allowed opacity-60 hover:bg-transparent',
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
      {install.supported ? null : <SettingsCardPill tone="neutral">{text.oldRelease}</SettingsCardPill>}
    </button>
  );
};
