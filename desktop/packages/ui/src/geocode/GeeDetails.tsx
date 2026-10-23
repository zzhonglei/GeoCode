import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsBackButton, SettingsCardPill } from '@/components/sections/shared/SettingsCards';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_HELPER_CLASS, SETTINGS_SECTION_TITLE_CLASS, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { configureGee, recheckGee } from './geoEngineClient';
import { useGeeSignIn, type SignIn } from './geeSignIn';
import { GeeStatusDetails } from './GeeStatusDetails';
import { ACCOUNT_MARK, isProjectId, projectOf, stepsOf, type Account, type Mark } from './geeSteps';
import { geeLabel, type GeeText } from './geeText';
import { lightOf, type GeeView } from './geoStatus';
import type { QgisText } from './qgisText';
import { TONE } from './settingsList';

const CODE_EDITOR = 'https://code.earthengine.google.com';

/** A step's mark as shown: one not yet done is being checked while a check runs. */
type Shown = Mark | 'busy';

const MARK_CLASS = {
  done: 'border-[var(--status-success)] bg-[var(--status-success)] text-white',
  problem: 'border-[var(--status-error)] bg-[var(--status-error)] text-white',
  todo: 'border-[var(--interactive-border-hover)] text-muted-foreground',
  busy: 'border-[var(--status-warning)] text-[var(--status-warning)] animate-pulse',
} satisfies Record<Shown, string>;

export const GeeDetails: React.FC<{
  text: GeeText;
  shared: QgisText;
  status: GeeView | undefined;
  revision: number;
  onBack: () => void;
}> = ({ text, shared, status, revision, onBack }) => {
  // The last finished check, whose steps stand while the next one runs for the same project.
  const [settled, setSettled] = React.useState(status?.status === 'checking' ? undefined : status);
  const dismiss = useGeeSignIn((state) => state.dismiss);
  const project = projectOf(status);
  const checking = status?.status === 'checking';
  const light = status ? lightOf(status.status) : 'idle';
  const standing = checking ? (settled && projectOf(settled) === project ? settled : undefined) : status;
  // A new project leaves the sign-in as it was found: only the project is being checked. The check still uses the
  // credentials to ask Google about the project, and says so should they have stopped working. A sign-in not yet known,
  // as after a check that failed, is being found out.
  const before = settled ? stepsOf(settled) : undefined;
  const kept = checking && before?.account !== 'unknown' ? before : undefined;
  const found = stepsOf(standing);
  const steps = kept ? { ...found, account: kept.account } : found;
  const shown = (mark: Mark, held = false): Shown => (checking && !held && mark !== 'done' ? 'busy' : mark);

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
      titleAccessory={status ? <SettingsCardPill tone={TONE[light]}>{geeLabel(status)}</SettingsCardPill> : null}
      // A file that cannot be read is read again on a recheck, the way back once it is fixed.
      headerEnd={
        <Button variant="outline" size="xs" disabled={checking} onClick={recheck}>
          {shared.recheck}
        </Button>
      }
    >
      {status && light === 'failed' ? (
        <div className="mb-6 border-s-2 border-[var(--status-error)] ps-3">
          <GeeStatusDetails status={status} text={shared} />
        </div>
      ) : null}
      <SettingsSection
        divider={false}
        title={<StepTitle number={1} title={text.accountHeading} mark={shown(ACCOUNT_MARK[steps.account], kept !== undefined)} text={text} />}
        settingsItem="geo-environment.gee.account"
      >
        <AccountRow account={steps.account} checking={checking && kept === undefined} text={text} copied={shared.copied} />
      </SettingsSection>
      <SettingsSection
        title={<StepTitle number={2} title={text.projectHeading} mark={shown(steps.project)} text={text} />}
        settingsItem="geo-environment.gee.project"
      >
        <ProjectRow configured={project} text={text} />
      </SettingsSection>
    </SettingsPageLayout>
  );
};

/** A section's heading with the step's number, which turns into its mark once the step is done or at fault. */
const StepTitle: React.FC<{ number: number; title: string; mark: Shown; text: GeeText }> = ({ number, title, mark, text }) => (
  <h2 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
    <span
      aria-hidden
      title={text.marks[mark]}
      className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold', MARK_CLASS[mark])}
    >
      {mark === 'done' ? <Icon name="check" className="size-3" /> : mark === 'problem' ? '!' : number}
    </span>
    {title}
    <span className="sr-only">{`, ${text.marks[mark]}`}</span>
  </h2>
);

/** Why a sign-in did not finish, in the interface's language where GeoEngine's code names a common reason. */
const signInFailure = (signIn: Extract<SignIn, { phase: 'failed' }>, text: GeeText) =>
  text.signInFailed(signIn.code === 'denied' ? text.denied : signIn.code === 'timeout' ? text.timedOut : signIn.reason);

/** A sign-in waiting for the browser; keyed by its address, so a new one starts uncopied. */
const Waiting: React.FC<{ url: string | null; text: GeeText; copied: string; onCancel: () => void }> = ({ url, text, copied, onCancel }) => {
  const [done, setDone] = React.useState(false);
  const copy = async () => {
    if (url) setDone((await copyTextToClipboard(url)).ok);
  };
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="typography-meta flex items-center gap-2 text-foreground">
          <Icon name="loader-4" className="size-3.5 animate-spin text-[var(--status-warning)]" aria-hidden />
          {text.waiting}
        </p>
        {url ? (
          <p className={cn(SETTINGS_HELPER_CLASS, 'mt-1')}>
            {text.noBrowser}
            <button type="button" onClick={() => { void copy(); }} className="ms-1 text-[var(--primary-text)] hover:underline">
              {done ? copied : text.copyLink}
            </button>
          </p>
        ) : null}
      </div>
      <Button variant="outline" size="xs" onClick={onCancel}>{text.cancel}</Button>
    </div>
  );
};

/** Signing in needs nothing of the configuration: the credentials are earthengine-api's own, on this computer. */
const AccountRow: React.FC<{ account: Account; checking: boolean; text: GeeText; copied: string }> = ({
  account,
  checking,
  text,
  copied,
}) => {
  const signIn = useGeeSignIn((state) => state.signIn);
  const start = useGeeSignIn((state) => state.start);
  const cancel = useGeeSignIn((state) => state.cancel);

  if (signIn.phase === 'waiting') {
    return <Waiting key={signIn.url ?? ''} url={signIn.url} text={text} copied={copied} onCancel={cancel} />;
  }

  const line = checking && account !== 'signed-in'
    ? text.checking
    : {
      unknown: text.notChecked,
      'signed-out': text.signedOut,
      expired: text.expired,
      'signed-in': text.signedIn,
    }[account];
  // Prominent where signing in is the next step; quiet where the user is signed in, so it is not pressed by mistake.
  const prominent = !checking && (account === 'signed-out' || account === 'expired');
  const label = account === 'signed-in' || account === 'expired' ? text.signInAgain : text.signIn;
  const failure = signIn.phase === 'failed' ? signInFailure(signIn, text) : null;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        {/* In place of the line, so a failure adds none and the page below stays where it is. */}
        <p
          className={cn(
            'typography-meta',
            failure ? 'text-[var(--status-error)]' : 'text-foreground',
          )}
        >
          {failure ?? line}
        </p>
      </div>
      <Button variant={prominent ? 'default' : 'ghost'} size="xs" disabled={checking} onClick={start}>
        {label}
      </Button>
    </div>
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

  return (
    <div>
      <form
        className="flex items-center gap-2"
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
          className="h-7 max-w-sm font-mono typography-meta"
        />
        <Button type="submit" variant="outline" size="xs" disabled={!savable}>
          {text.save}
        </Button>
      </form>
      {/* In place of the help, so a mistyped ID adds no line and the page below stays where it is. */}
      {invalid ? (
        <p className={cn(SETTINGS_HELPER_CLASS, 'mt-1.5 text-[var(--status-error)]')}>{text.projectInvalid}</p>
      ) : (
        <p className={cn(SETTINGS_HELPER_CLASS, 'mt-1.5')}>
          {text.projectHelp[0]}
          <button type="button" onClick={() => { void openExternalUrl(CODE_EDITOR); }} className="text-[var(--primary-text)] hover:underline">
            Earth Engine Code Editor
          </button>
          {text.projectHelp[1]}
        </p>
      )}
    </div>
  );
};
