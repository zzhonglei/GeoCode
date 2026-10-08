import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsBackButton, SettingsCardPill, type SettingsCardTone } from '@/components/sections/shared/SettingsCards';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_HELPER_CLASS, SETTINGS_SECTION_TITLE_CLASS, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { configureGee, fetchGeePythons, pickPythonFolder, recheckGee, type GeePython } from './geoEngineClient';
import { useGeeSignIn, type SignIn } from './geeSignIn';
import { GeeStatusDetails } from './GeeStatusDetails';
import { ACCOUNT_MARK, configuredOf, isProjectId, sameConfigured, stepsOf, type Account, type Mark } from './geeSteps';
import { geeLabel, type GeeText } from './geeText';
import { lightOf, type GeeView } from './geoStatus';
import type { QgisText } from './qgisText';
import { LIST_CLASS, ROW_CLASS, TONE } from './settingsList';

const CODE_EDITOR = 'https://code.earthengine.google.com';

type Pythons =
  | { kind: 'loading' }
  /** `against` is the configured path the scan marked its Python against. */
  | { kind: 'found'; pythons: GeePython[]; against?: string }
  | { kind: 'failed'; reason: string };

/**
 * A choice shown as made until a status after its write arrives; `after` is the revision held when the write landed.
 * A folder chosen elsewhere is shown by its folder, GeoEngine finding the Python in it.
 */
type Pending = { python: string; after: number | null };

/** A step's mark as shown: one not yet done is being checked while a check runs. */
type Shown = Mark | 'busy';

const MARK_CLASS = {
  done: 'border-[var(--status-success)] bg-[var(--status-success)] text-white',
  problem: 'border-[var(--status-error)] bg-[var(--status-error)] text-white',
  todo: 'border-[var(--interactive-border-hover)] text-muted-foreground',
  busy: 'border-[var(--status-warning)] text-[var(--status-warning)] animate-pulse',
} satisfies Record<Shown, string>;

/** A conda environment's name from its path, or the interpreter's file name. */
const nameOf = (python: string) => {
  const parts = python.split(/[\\/]/);
  const envs = parts.lastIndexOf('envs');
  return (envs >= 0 ? parts[envs + 1] : undefined) ?? parts.at(-1) ?? python;
};

export const GeeDetails: React.FC<{
  text: GeeText;
  shared: QgisText;
  status: GeeView | undefined;
  revision: number;
  onBack: () => void;
}> = ({ text, shared, status, revision, onBack }) => {
  const [pythons, setPythons] = React.useState<Pythons>({ kind: 'loading' });
  const [pending, setPending] = React.useState<Pending | null>(null);
  // The last finished check, whose steps stand while the next one runs for the same configuration.
  const [settled, setSettled] = React.useState(status?.status === 'checking' ? undefined : status);
  const dismiss = useGeeSignIn((state) => state.dismiss);
  const revisionRef = React.useRef(revision);
  revisionRef.current = revision;
  const configured = configuredOf(status);
  const checking = status?.status === 'checking';
  // GeoEngine refuses to write over a file it cannot read; the diagnostics above name the file and where it breaks.
  const locked = status?.status === 'config-error';
  const light = status ? lightOf(status.status) : 'idle';
  const standing = checking ? (settled && sameConfigured(configuredOf(settled), configured) ? settled : undefined) : status;
  // A new project leaves the Python and the sign-in as they were found: only the project is being checked. The check
  // still uses the credentials to ask Google about the project, and says so should they have stopped working.
  const kept = checking && settled && configuredOf(settled).python === configured.python ? stepsOf(settled) : undefined;
  const found = stepsOf(standing);
  const steps = kept ? { ...found, python: kept.python, account: kept.account } : found;
  // With a Python configured, what the sign-in is waits for the check, not for a choice.
  const account: Account = steps.account === 'no-python' && configured.python ? 'unknown' : steps.account;
  const shown = (mark: Mark, held = false): Shown => (checking && !held && mark !== 'done' ? 'busy' : mark);
  // Signing in runs earthengine-api in the configured Python, which then has to start and have it.
  const withoutEarthEngine = status?.status === 'python-missing'
    || (status?.status === 'packages-missing' && (status.diagnostics.missing ?? []).includes('earthengine-api'));

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

  const scan = React.useCallback(() => {
    setPythons({ kind: 'loading' });
    void fetchGeePythons().then((outcome) => {
      setPythons(outcome.ok
        ? { kind: 'found', pythons: outcome.value.pythons, against: outcome.value.configured }
        : { kind: 'failed', reason: outcome.reason });
    });
  }, []);

  React.useEffect(scan, [scan]);

  // Whatever the configuration names once a later status arrives wins, even if it is not this choice.
  React.useEffect(() => {
    if (!pending) return;
    if (pending.python === configured.python) setPending(null);
    if (pending.after !== null && revision > pending.after) setPending(null);
  }, [configured.python, pending, revision]);

  const listed = pythons.kind === 'found' ? pythons.pythons : [];
  // By the path written or, as GeoEngine found it, by what it is: a link to the same interpreter is the same Python.
  // The mark holds only for the configuration it was made against.
  const marked = pythons.kind === 'found' && pythons.against !== undefined && pythons.against === configured.python;
  const isConfigured = (python: GeePython) =>
    python.python === configured.python
    || (marked && python.configured === true && !listed.some((other) => other.python === configured.python));
  const isChosen = (python: GeePython) => (pending ? python.python === pending.python : isConfigured(python));

  const write = (setting: { python: string } | { environment: string }, shownAs: string) => {
    setPending({ python: shownAs, after: null });
    void configureGee(setting).then((outcome) => {
      if (outcome.ok) {
        // As GeoEngine found it in a folder: the Python already configured clears the choice, with no status to come.
        const python = outcome.value.python ?? shownAs;
        setPending((current) => (current?.python === shownAs ? { python, after: revisionRef.current } : current));
        return;
      }
      setPending((current) => (current?.python === shownAs ? null : current));
      toast.error(text.chooseFailed(outcome.reason));
    });
  };

  const choose = (python: GeePython) => {
    if (!isChosen(python)) write({ python: python.python }, python.python);
  };

  const chooseElsewhere = async () => {
    const near = configured.python?.replace(/[\\/][^\\/]*$/, '');
    const folder = await pickPythonFolder(text.pickPython, near);
    if (folder) write({ environment: folder }, folder);
  };

  const recheck = () => {
    void recheckGee().then((outcome) => {
      if (!outcome.ok) toast.error(text.recheckFailed(outcome.reason));
    });
  };

  const extra = (python: string): GeePython => ({
    python,
    name: nameOf(python),
    version: status?.status === 'ready' ? status.versions.python : undefined,
    earthengine: status?.status === 'ready' ? status.versions['earthengine-api'] : undefined,
    missing: status?.status === 'packages-missing' ? status.diagnostics.missing ?? [] : [],
  });
  // The configured Python, and a choice on its way, stay in the list when the scan does not find them, so a missing
  // one is seen as missing.
  const unlisted = [
    configured.python && !listed.some(isConfigured) ? configured.python : undefined,
    pending && pending.python !== configured.python && !listed.some((python) => python.python === pending.python) ? pending.python : undefined,
  ].filter((python): python is string => python !== undefined);
  const rows = [...unlisted.map(extra), ...listed];

  return (
    <SettingsPageLayout
      title="Google Earth Engine"
      titleLeading={<SettingsBackButton label={shared.back} onClick={onBack} />}
      titleAccessory={status ? <SettingsCardPill tone={TONE[light]}>{geeLabel(status)}</SettingsCardPill> : null}
      // A file that cannot be read is read again on a recheck, the way back once it is fixed.
      headerEnd={configured.python || locked ? (
        <Button variant="outline" size="xs" disabled={checking} onClick={recheck}>
          {shared.recheck}
        </Button>
      ) : null}
    >
      {status && light === 'failed' ? (
        <div className="mb-6 border-l-2 border-[var(--status-error)] pl-3">
          <GeeStatusDetails status={status} text={shared} />
        </div>
      ) : null}
      <SettingsSection
        divider={false}
        title={<StepTitle number={1} title={text.pythonHeading} mark={shown(steps.python, kept !== undefined)} text={text} />}
        headerAction={(
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={locked} onClick={() => void chooseElsewhere()}>
              {shared.chooseOther}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              disabled={pythons.kind === 'loading'}
              onClick={scan}
              aria-label={shared.rescan}
              title={shared.rescan}
            >
              <Icon name="refresh" className={cn('size-4', pythons.kind === 'loading' && 'animate-spin')} />
            </Button>
          </div>
        )}
        settingsItem="geo-environment.gee.python"
      >
        {pythons.kind === 'failed' ? (
          <p className="typography-meta mb-2 text-[var(--status-error)]">{text.scanFailed(pythons.reason)}</p>
        ) : null}
        {pythons.kind === 'found' && rows.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{text.noPythons}</p> : null}
        {rows.length > 0 ? (
          <div role="radiogroup" aria-label={text.pythonHeading} aria-disabled={locked || undefined} className={LIST_CLASS}>
            {rows.map((python) => (
              <PythonRow
                key={python.python}
                python={python}
                text={text}
                inUse={shared.inUse}
                selected={isChosen(python)}
                tone={isChosen(python) && !pending ? TONE[light] : 'neutral'}
                locked={locked}
                onSelect={() => choose(python)}
              />
            ))}
          </div>
        ) : null}
        <p className={cn(SETTINGS_HELPER_CLASS, 'mt-1.5')}>{text.pythonHelp}</p>
      </SettingsSection>
      <SettingsSection
        title={<StepTitle number={2} title={text.accountHeading} mark={shown(ACCOUNT_MARK[account], kept !== undefined)} text={text} />}
        settingsItem="geo-environment.gee.account"
      >
        <AccountRow
          account={account}
          checking={checking && kept === undefined}
          usable={configured.python !== undefined && !locked && !withoutEarthEngine}
          text={text}
          copied={shared.copied}
        />
      </SettingsSection>
      <SettingsSection
        title={<StepTitle number={3} title={text.projectHeading} mark={shown(steps.project)} text={text} />}
        settingsItem="geo-environment.gee.project"
      >
        <ProjectRow configured={configured.project} locked={locked} text={text} />
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

const PythonRow: React.FC<{
  python: GeePython;
  text: GeeText;
  inUse: string;
  selected: boolean;
  tone: SettingsCardTone;
  locked: boolean;
  onSelect: () => void;
}> = ({ python, text, inUse, selected, tone, locked, onSelect }) => {
  const versions = [
    python.version ? `Python ${python.version}` : null,
    python.earthengine ? `earthengine-api ${python.earthengine}` : null,
  ].filter(Boolean).join(' · ');
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
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2.5">
          <span className="typography-ui-label shrink-0 font-medium text-foreground">{python.name}</span>
          {versions ? <span className="typography-meta min-w-0 truncate text-muted-foreground">{versions}</span> : null}
        </span>
        <span className="typography-micro block truncate font-mono text-muted-foreground" title={python.python}>{python.python}</span>
      </span>
      {python.missing.length > 0 ? (
        <span className="typography-micro shrink-0 text-[var(--status-warning)]">{text.missing(python.missing)}</span>
      ) : null}
      {selected ? <SettingsCardPill tone={tone}>{inUse}</SettingsCardPill> : null}
    </button>
  );
};

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
            <button type="button" onClick={() => { void copy(); }} className="ml-1 text-[var(--primary-text)] hover:underline">
              {done ? copied : text.copyLink}
            </button>
          </p>
        ) : null}
      </div>
      <Button variant="outline" size="xs" onClick={onCancel}>{text.cancel}</Button>
    </div>
  );
};

const AccountRow: React.FC<{ account: Account; checking: boolean; usable: boolean; text: GeeText; copied: string }> = ({
  account,
  checking,
  usable,
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
      'no-python': text.noPython,
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
            failure ? 'text-[var(--status-error)]' : account === 'no-python' ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {failure ?? line}
        </p>
      </div>
      <Button variant={prominent ? 'default' : 'ghost'} size="xs" disabled={!usable || checking} onClick={start}>
        {label}
      </Button>
    </div>
  );
};

const ProjectRow: React.FC<{ configured: string | undefined; locked: boolean; text: GeeText }> = ({ configured, locked, text }) => {
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
  const savable = trimmed !== '' && !invalid && trimmed !== configured && !locked && !saving;

  const save = () => {
    if (!savable) return;
    setSaving(true);
    void configureGee({ project: trimmed }).then((outcome) => {
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
          disabled={locked}
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
