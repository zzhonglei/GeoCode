import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn, getRevealLabelKey } from '@/lib/utils';
import { configureGee, recheckGee } from './geoEngineClient';
import { CheckFrame, CheckSteps, OverviewBackdrop, Uses, Verdict, type Use, type VerdictKind } from './GeoDetailsParts';
import { GeeLogo } from './GeeLogo';
import { GeeQuotaStrip } from './GeeQuota';
import { useGeeSignIn, type SignIn } from './geeSignIn';
import { accountOf, faultOf, isProjectId, marksOf, projectOf, type Account, type GeeFault } from './geeSteps';
import { openPermissions } from './geoSettingsStore';
import { geeDiagnosticsOf, type GeeText } from './geeText';
import { lightOf, type GeeView, type Light } from './geoStatus';
import { LightPill } from './QgisDetails';
import type { QgisText } from './qgisText';

const CODE_EDITOR = 'https://code.earthengine.google.com';
const REGISTER = 'https://code.earthengine.google.com/register';
const enableApiUrl = (project: string) =>
  `https://console.cloud.google.com/apis/library/earthengine.googleapis.com?project=${encodeURIComponent(project)}`;

/** Earth Engine's own blue, in the interface's theme: the overview's colour once it is ready, and the icons of the rows and uses. */
const ACCENT = 'var(--status-info)';

/** Not set up yet rather than broken: the user has yet to sign in or to name a project. */
const unsetOf = (status: GeeView | undefined) =>
  status?.status === 'signed-out' || status?.status === 'project-missing' ? status.status : undefined;

/**
 * The Earth Engine settings page: the project in use with this month's quota, the account and the project to set, the
 * check step by step, and what GeoCode uses it for. Every part keeps its place and height whatever the state: a failure
 * changes colours and words, never the layout.
 */
export const GeeDetails: React.FC<{
  text: GeeText;
  shared: QgisText;
  status: GeeView | undefined;
  revision: number;
  onBack: () => void;
}> = ({ text, shared, status, revision, onBack }) => {
  // The last finished check, which stands while the next one runs for the same project.
  const [settled, setSettled] = React.useState(status?.status === 'checking' ? undefined : status);
  const dismiss = useGeeSignIn((state) => state.dismiss);
  const project = projectOf(status);
  const checking = status?.status === 'checking';
  const light: Light | undefined = status ? lightOf(status.status) : undefined;
  const standing = checking ? (settled && projectOf(settled) === project ? settled : undefined) : status;
  // A new project leaves the sign-in as it was found: only the project is being checked. The check still uses the
  // credentials to ask Google about the project, and says so should they have stopped working. A sign-in not yet known,
  // as after a check that failed, is being found out.
  const before = settled ? accountOf(settled) : undefined;
  const kept = checking && before !== undefined && before !== 'unknown' ? before : undefined;
  const account = kept ?? accountOf(standing);

  // The revision the page last saw settle; parsing makes a new status object whenever any domain changes.
  const settledAt = React.useRef(revision);
  React.useEffect(() => {
    if (!status || status.status === 'checking') return;
    setSettled(status);
    if (revision === settledAt.current) return;
    const first = settledAt.current < 0;
    settledAt.current = revision;
    // A check after a failed sign-in says where the sign-in stands, and the failure is old news; the first status a
    // page opened before any arrived is no check after it.
    if (!first) dismiss();
  }, [status, revision, dismiss]);

  const recheck = () => {
    void recheckGee().then((outcome) => {
      if (!outcome.ok) toast.error(text.recheckFailed(outcome.reason));
    });
  };

  return (
    <SettingsPageLayout
      title="Google Earth Engine"
      titleLeading={<SettingsBackButton label={shared.back} onClick={onBack} />}
      titleAccessory={<LightPill light={light} text={shared} />}
    >
      <SettingsSection divider={false} settingsItem="geo-environment.gee">
        <Overview
          status={status}
          // Kept while the same project is checked again, so the quota does not empty and fill again.
          quotaProject={standing?.status === 'ready' ? standing.project : undefined}
          text={text}
          shared={shared}
          onRecheck={recheck}
        />
      </SettingsSection>
      <SettingsSection title={text.setupHeading} settingsItem="geo-environment.gee.account">
        <div className="rounded-xl border border-[var(--interactive-border)]">
          <AccountRow account={account} checking={checking && kept === undefined} text={text} copied={shared.copied} />
          <ProjectRow configured={project} text={text} />
        </div>
      </SettingsSection>
      <SettingsSection title={shared.checkHeading} description={text.checkDescription}>
        <Check status={status} signedIn={kept === 'signed-in'} text={text} shared={shared} />
      </SettingsSection>
      <SettingsSection
        title={shared.usesHeading}
        headerAction={(
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={openPermissions}>
            {shared.permissions}
            <Icon name="arrow-right" className="size-3.5" />
          </Button>
        )}
      >
        <Uses uses={usesOf(text)} ready={light === 'ready'} colour={ACCENT} />
      </SettingsSection>
    </SettingsPageLayout>
  );
};

/**
 * The project in use and how it stands, or what is missing before there is one; below a hairline, this month's quota.
 * The settings file, when it cannot be read, takes the project's line, to be shown in Finder or File Explorer.
 */
const Overview: React.FC<{
  status: GeeView | undefined;
  quotaProject: string | undefined;
  text: GeeText;
  shared: QgisText;
  onRecheck: () => void;
}> = ({ status, quotaProject, text, shared, onRecheck }) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const unset = unsetOf(status);
  const light = status && !unset ? lightOf(status.status) : 'idle';
  const project = unset ? undefined : projectOf(status);
  const file = status && 'diagnostics' in status ? status.diagnostics.file : undefined;
  const reveal = files.revealPath;
  const name = unset ? (unset === 'signed-out' ? text.unset.signedOut : text.unset.projectMissing) : project ?? 'Google Earth Engine';

  let second: React.ReactNode = null;
  if (unset) second = <p className={SECOND_LINE_CLASS}>{text.unsetText}</p>;
  else if (project) {
    second = (
      <p className={cn(SECOND_LINE_CLASS, 'flex items-center gap-1.5')}>
        <span className="shrink-0">{text.projectKind}</span>
        <span aria-hidden className="shrink-0 opacity-60">·</span>
        <button
          type="button"
          onClick={() => { void openExternalUrl(CODE_EDITOR); }}
          className="group flex min-w-0 items-center gap-1 hover:text-foreground"
        >
          <span className="truncate group-hover:underline group-hover:underline-offset-2">{text.openEditor}</span>
          <Icon name="external-link" className="size-3 shrink-0" aria-hidden />
        </button>
      </p>
    );
  } else if (file && reveal) {
    second = (
      <button
        type="button"
        onClick={() => { void reveal(file).catch(() => toast.error(t('sidebarFilesTree.toast.revealFailed'))); }}
        title={t(getRevealLabelKey())}
        className="group typography-micro mt-0.5 flex h-5 max-w-full items-center gap-1.5 leading-5 text-muted-foreground hover:text-foreground"
      >
        <span className="truncate group-hover:underline group-hover:underline-offset-2">{file}</span>
        <Icon name="folder-received" className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-80" aria-hidden />
      </button>
    );
  } else second = <p className={SECOND_LINE_CLASS}>{file}</p>;

  return (
    <div className="oc-tile overflow-hidden rounded-xl">
      <div className="relative overflow-hidden">
        <OverviewBackdrop light={light} ready={ACCENT} texture="graticule" />
        <div className="relative flex items-center gap-3.5 p-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-background)] ring-1 ring-[var(--interactive-border)] ring-inset">
            <GeeLogo className={cn('size-7', light === 'idle' && 'opacity-45 grayscale')} />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                'h-6 truncate leading-6 text-foreground',
                project ? 'font-mono text-[15px] font-semibold' : 'text-[17px] font-semibold tracking-[-0.01em]',
              )}
              title={name}
            >
              {name}
            </p>
            {second}
          </div>
          {/* Shown before setup too: a sign-in made in a terminal is found only by checking again, and a recheck reads
              the settings file again should its watch have died. Kept in place until there is a status, so its
              arrival moves nothing. */}
          <Button
            variant="ghost"
            size="xs"
            className={cn('shrink-0 text-muted-foreground', !status && 'invisible')}
            disabled={status?.status === 'checking'}
            onClick={onRecheck}
            title={shared.recheck}
          >
            <Icon name="refresh" className="size-3.5" />
            <span className="hidden @md:inline">{shared.recheck}</span>
          </Button>
        </div>
      </div>
      <GeeQuotaStrip project={quotaProject} text={text.quota} />
    </div>
  );
};

const SECOND_LINE_CLASS = 'typography-micro mt-0.5 h-5 truncate leading-5 text-muted-foreground';

/** Why a sign-in did not finish, in the interface's language where GeoEngine's code names a common reason. */
const signInFailure = (signIn: Extract<SignIn, { phase: 'failed' }>, text: GeeText) =>
  text.signInFailed(signIn.code === 'denied' ? text.denied : signIn.code === 'timeout' ? text.timedOut : signIn.reason);

/** A row of the account and project: its icon, its name over a line, and what it is set with. */
const SetupRow: React.FC<{
  icon: IconName;
  title: string;
  line: React.ReactNode;
  children: React.ReactNode;
  settingsItem?: string;
  stacked?: boolean;
}> = ({ icon, title, line, children, settingsItem, stacked = false }) => (
  <div
    data-settings-item={settingsItem}
    className={cn(
      'grid min-h-[66px] items-center gap-x-3 gap-y-2 px-4 py-3.5 [&+&]:border-t [&+&]:border-[var(--interactive-border)]',
      // Below @xl the project's field goes under its name, as wide as the line above it.
      stacked ? 'grid-cols-[34px_minmax(0,1fr)] @xl:grid-cols-[34px_minmax(0,1fr)_auto]' : 'grid-cols-[34px_minmax(0,1fr)_auto]',
    )}
  >
    <span className="oc-tile-inset flex size-[34px] items-center justify-center rounded-[9px]" style={{ color: ACCENT }}>
      <Icon name={icon} className="size-[17px]" />
    </span>
    <div className="min-w-0">
      <p className="typography-ui-label font-semibold leading-[18px] text-foreground">{title}</p>
      <div className="typography-micro mt-0.5 flex h-[18px] min-w-0 items-center gap-1.5 leading-[18px] text-muted-foreground">{line}</div>
    </div>
    <div className={cn('flex min-w-0 items-center justify-end gap-1.5', stacked && 'col-start-2 justify-start @xl:col-start-auto @xl:justify-end')}>
      {children}
    </div>
  </div>
);

/** A sign-in waiting for the browser; keyed by its address, so a new one starts uncopied. */
const WaitingLine: React.FC<{ url: string | null; text: GeeText; copied: string }> = ({ url, text, copied }) => {
  const [done, setDone] = React.useState(false);
  const copy = async () => {
    if (url) setDone((await copyTextToClipboard(url)).ok);
  };
  return (
    <>
      <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-[var(--status-warning)]" aria-hidden />
      <span className="truncate text-foreground">{text.waiting}</span>
      {url ? (
        <button type="button" onClick={() => { void copy(); }} title={text.noBrowser} className="shrink-0 text-[var(--primary-text)] hover:underline">
          {done ? copied : text.copyLink}
        </button>
      ) : null}
    </>
  );
};

/** Signing in needs nothing of the configuration: the credentials are earthengine-api's own, on this computer. */
const AccountRow: React.FC<{ account: Account; checking: boolean; text: GeeText; copied: string }> = ({ account, checking, text, copied }) => {
  const signIn = useGeeSignIn((state) => state.signIn);
  const start = useGeeSignIn((state) => state.start);
  const cancel = useGeeSignIn((state) => state.cancel);

  if (signIn.phase === 'waiting') {
    return (
      <SetupRow icon="user-3" title={text.accountHeading} line={<WaitingLine key={signIn.url ?? ''} url={signIn.url} text={text} copied={copied} />}>
        <Button variant="outline" size="xs" onClick={cancel}>{text.cancel}</Button>
      </SetupRow>
    );
  }

  const words = checking && account !== 'signed-in'
    ? text.checking
    : { unknown: text.notChecked, 'signed-out': text.signedOut, expired: text.expired, 'signed-in': text.signedIn }[account];
  // In place of the line, so a failure adds none and the page below stays where it is.
  const failure = signIn.phase === 'failed' ? signInFailure(signIn, text) : null;
  const tone = failure || account === 'expired' ? 'text-[var(--status-error)]' : account === 'signed-in' ? 'text-foreground' : undefined;
  // Prominent where signing in is the next step; quiet where the user is signed in, so it is not pressed by mistake.
  const prominent = !checking && (failure !== null || account === 'signed-out' || account === 'expired');
  const label = account === 'signed-in' || account === 'expired' ? text.signInAgain : text.signIn;

  return (
    <SetupRow icon="user-3" title={text.accountHeading} line={<span className={cn('truncate', tone)} title={failure ?? undefined}>{failure ?? words}</span>}>
      <Button variant={prominent ? 'default' : 'ghost'} size="xs" className={prominent ? undefined : 'text-muted-foreground'} disabled={checking} onClick={start}>
        {label}
      </Button>
    </SetupRow>
  );
};

/** Savable while the configuration cannot be read too: saving the project is how a block written wrong is fixed. */
const ProjectRow: React.FC<{ configured: string | undefined; text: GeeText }> = ({ configured, text }) => {
  const [draft, setDraft] = React.useState(configured ?? '');
  // Edited by the user and not yet what the configuration holds: a status arriving then leaves the field alone.
  const [edited, setEdited] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const trimmed = draft.trim();

  React.useEffect(() => {
    if (!edited) setDraft(configured ?? '');
    else if (configured !== undefined && configured === draft.trim()) setEdited(false);
  }, [configured, draft, edited]);

  const invalid = trimmed !== '' && !isProjectId(trimmed);
  const savable = trimmed !== '' && !invalid && trimmed !== configured && !saving;

  const save = () => {
    if (!savable) return;
    setSaving(true);
    void configureGee(trimmed).then((outcome) => {
      setSaving(false);
      if (!outcome.ok) toast.error(text.saveFailed(outcome.reason));
    });
  };

  // In place of the help, so a mistyped ID adds no line and the page below stays where it is.
  const line = invalid ? (
    <span className="truncate text-[var(--status-error)]">{text.projectInvalid}</span>
  ) : (
    <span className="truncate">
      {text.projectHelp[0]}
      <button type="button" onClick={() => { void openExternalUrl(CODE_EDITOR); }} className="text-[var(--primary-text)] hover:underline">
        Earth Engine Code Editor
      </button>
      {text.projectHelp[1]}
    </span>
  );

  return (
    <SetupRow icon="cloud" title={text.projectHeading} line={line} settingsItem="geo-environment.gee.project" stacked>
      <form
        // Wide enough for a project ID of 30 characters, the longest a new Google Cloud project may have.
        className="flex min-w-0 flex-1 items-center gap-1.5 @xl:w-80 @xl:flex-none"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setEdited(true);
          }}
          placeholder={text.projectPlaceholder}
          aria-label={text.projectHeading}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={invalid || undefined}
          className="h-7 min-w-0 flex-1 font-mono typography-meta"
        />
        <Button type="submit" variant="outline" size="xs" disabled={!savable}>
          {text.save}
        </Button>
      </form>
    </SetupRow>
  );
};

/** The check's verdict for a state that is no fault. */
type Calm = { kind: VerdictKind; line: string };

const calmOf = (status: GeeView | undefined, text: GeeText): Calm => {
  if (!status || status.status === 'checking') return { kind: 'checking', line: text.verdicts.checking };
  if (status.status === 'ready') return { kind: 'ready', line: text.verdicts.ready };
  return { kind: 'idle', line: status.status === 'signed-out' ? text.verdicts.signedOut : text.verdicts.projectMissing };
};

/** The check as GeoEngine makes it, in four steps, and its verdict with a way to put a failure right where there is one. */
const Check: React.FC<{ status: GeeView | undefined; signedIn: boolean; text: GeeText; shared: QgisText }> = ({ status, signedIn, text, shared }) => {
  const start = useGeeSignIn((state) => state.start);
  const waiting = useGeeSignIn((state) => state.signIn.phase === 'waiting');
  const fault = faultOf(status);
  const project = projectOf(status) ?? '';
  const passed = [text.stepFound, project, text.stepValid, shared.stepWorks];
  const steps = marksOf(status, signedIn).map((mark, i) => {
    const detail = {
      done: passed[i],
      failed: fault === 'unreachable' ? text.stepUnreachable : shared.stepFailed,
      busy: shared.stepWaiting,
      todo: i === 0 ? text.stepSignedOut : text.stepNotSet,
      waiting: '',
      skipped: shared.stepNotRun,
    }[mark];
    return { name: text.steps[i], mark, detail };
  });
  const calm = fault ? undefined : calmOf(status, text);

  return (
    <CheckFrame>
      <CheckSteps steps={steps} columns={4} />
      <Verdict
        kind={calm?.kind ?? 'failed'}
        line={fault ? text.explain[fault] : calm?.line ?? ''}
        diagnostics={status && fault ? geeDiagnosticsOf(status) : ''}
        action={fault ? <Remedy fault={fault} project={project} text={text} onSignIn={start} disabled={waiting} /> : null}
        text={shared}
      />
    </CheckFrame>
  );
};

/** The sure way to put a failure right, where there is one: signing in again, enabling the API, registering. */
const Remedy: React.FC<{ fault: GeeFault; project: string; text: GeeText; onSignIn: () => void; disabled: boolean }> = ({
  fault,
  project,
  text,
  onSignIn,
  disabled,
}) => {
  if (fault === 'credentials-invalid') {
    return <Button variant="ghost" size="xs" className="text-[var(--primary-text)]" disabled={disabled} onClick={onSignIn}>{text.signInAgain}</Button>;
  }
  const link = fault === 'api-disabled' && project ? { label: text.enableApi, url: enableApiUrl(project) } : fault === 'refused' ? { label: text.register, url: REGISTER } : undefined;
  if (!link) return null;
  return (
    <Button variant="ghost" size="xs" className="text-[var(--primary-text)]" onClick={() => { void openExternalUrl(link.url); }}>
      {link.label}
      <Icon name="external-link" className="size-3.5" />
    </Button>
  );
};

/** What the agent does with Earth Engine, all through geerun. */
const usesOf = (text: GeeText): Use[] => [
  { key: 'analyse', icon: 'global', tool: 'geerun', ...text.uses.analyse },
  { key: 'assets', icon: 'stack', tool: 'geerun', ...text.uses.assets },
  { key: 'export', icon: 'download', tool: 'geerun', ...text.uses.export },
];
