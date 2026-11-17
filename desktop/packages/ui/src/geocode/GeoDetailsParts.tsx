import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import type { Light } from './geoStatus';

/**
 * The parts the settings pages of QGIS and Google Earth Engine share: the overview's backdrop, the check drawn step by
 * step with its verdict, and what GeoCode uses the software for. Each part keeps its height whatever the state.
 */

/** The colour of a light, for the overview's texture and glow; `ready` is the software's own. */
const tintOf = (light: Light, ready: string) =>
  ({ ready, checking: 'var(--status-warning)', failed: 'var(--status-error)', idle: 'var(--muted-foreground)' })[light];

/** Contour lines, as behind the QGIS overview. */
const CONTOURS = [0, 1, 2, 3, 4, 5, 6].map(
  (i) => `M${40 - i * 4} ${200 - i * 6} C ${70 + i * 6} ${150 - i * 14}, ${110 + i * 4} ${170 - i * 18}, ${150 + i * 2} ${120 - i * 12} S ${230 - i * 3} ${60 - i * 6}, 300 ${50 - i * 9}`,
);

const Contours: React.FC<{ className: string }> = ({ className }) => (
  <svg viewBox="0 0 300 220" fill="none" stroke="currentColor" strokeWidth="1" className={cn('absolute -end-9 -top-11 h-[230px] w-[320px]', className)}>
    {CONTOURS.map((d, i) => <path key={d} d={d} opacity={1 - i * 0.11} />)}
    {[0, 1, 2].map((i) => (
      <ellipse key={i} cx="225" cy="95" rx={26 + i * 18} ry={16 + i * 12} transform="rotate(-18 225 95)" opacity={0.9 - i * 0.25} />
    ))}
  </svg>
);

/** A globe's meridians and parallels, as behind the Earth Engine overview. */
const GLOBE = { centre: 165, radius: 150 } as const;
const MERIDIANS = [15, 35, 55, 75].map((degrees) => GLOBE.radius * Math.cos((degrees * Math.PI) / 180));
const PARALLELS = [-60, -40, -20, 0, 20, 40, 60].map((degrees) => ({
  y: GLOBE.centre + GLOBE.radius * Math.sin((degrees * Math.PI) / 180),
  half: GLOBE.radius * Math.cos((degrees * Math.PI) / 180),
}));

const Graticule: React.FC<{ className: string }> = ({ className }) => {
  const { centre, radius } = GLOBE;
  return (
    <svg viewBox="0 0 330 330" fill="none" stroke="currentColor" strokeWidth="1" className={cn('absolute -end-[70px] -top-[120px] size-[330px]', className)}>
      <g transform={`rotate(-16 ${centre} ${centre})`}>
        <circle cx={centre} cy={centre} r={radius} strokeWidth="1.3" />
        {MERIDIANS.map((rx) => <ellipse key={rx} cx={centre} cy={centre} rx={rx} ry={radius} />)}
        <line x1={centre} y1={centre - radius} x2={centre} y2={centre + radius} />
        {PARALLELS.map(({ y, half }) => <ellipse key={y} cx={centre} cy={y} rx={half} ry={half * 0.16} />)}
      </g>
    </svg>
  );
};

/**
 * Behind the overview's upper part: a glow from its top corner, and a texture on its right fading towards the text,
 * both in the colour of the light. Decoration only.
 */
export const OverviewBackdrop: React.FC<{ light: Light; ready: string; texture: 'contours' | 'graticule' }> = ({ light, ready, texture }) => {
  const tint = tintOf(light, ready);
  const Texture = texture === 'contours' ? Contours : Graticule;
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={light === 'idle' ? undefined : { background: `radial-gradient(90% 120% at 0% 0%, color-mix(in srgb, ${tint} 9%, transparent), transparent 60%)` }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 end-0 w-[62%] overflow-hidden [mask-image:linear-gradient(to_left,#000_35%,transparent)]"
        style={{ color: tint }}
      >
        <Texture className={light === 'idle' ? 'opacity-20' : texture === 'contours' ? 'opacity-50' : 'opacity-40'} />
      </div>
    </>
  );
};

/**
 * How a step of a check stands: passed, failed, being checked, the user's next step (no fault), waiting for the
 * steps before it to be set up, or not run because one before it failed.
 */
export type StepMark = 'done' | 'failed' | 'busy' | 'todo' | 'waiting' | 'skipped';

type CheckStep = { readonly name: string; readonly mark: StepMark; readonly detail: string };

const DOT_CLASS = {
  done: 'border-[var(--status-success)] bg-[var(--status-success)] text-white',
  failed: 'border-[var(--status-error)] bg-[var(--status-error)] text-white',
  busy: 'border-[var(--status-warning)] bg-[var(--surface-background)] text-[var(--status-warning)]',
  todo: 'border-muted-foreground bg-[var(--surface-background)] text-foreground',
  waiting: 'border-[var(--interactive-border-hover)] bg-[var(--surface-background)] text-muted-foreground',
  skipped: 'border-dashed border-[var(--interactive-border-hover)] bg-[var(--surface-background)] text-muted-foreground',
} satisfies Record<StepMark, string>;

/** Six steps to a row for QGIS, four for Earth Engine; a column below the container's @xl. */
const ROW_CLASS = { 4: '@xl:grid-cols-4', 6: '@xl:grid-cols-6' } as const;

/** Where the row's line starts and ends: at the first and last dots, half a column in. */
const LINE_INSET = { 4: 'start-[12.5%] end-[12.5%]', 6: 'start-[8.333%] end-[8.333%]' } as const;

/** The steps of a check in order, a line joining them, green as far as the last step passed or the one that failed. */
export const CheckSteps: React.FC<{ steps: readonly CheckStep[]; columns: 4 | 6 }> = ({ steps, columns }) => {
  const blink = useWaitingBlink(steps.some((step) => step.mark === 'busy'));
  const reached = steps.reduce((last, step, i) => (step.mark === 'done' || step.mark === 'failed' ? i : last), 0);
  const share = `${(reached / (steps.length - 1)) * 100}%`;
  return (
    <ol className={cn('relative grid grid-cols-1', ROW_CLASS[columns])}>
      {/* The line through the dots: down their centres in a column, across them in a row. */}
      <span aria-hidden className="absolute start-[12px] top-[19px] bottom-[19px] w-0.5 bg-[var(--interactive-border-hover)] @xl:hidden">
        <span className="absolute inset-x-0 top-0 bg-[var(--status-success)]" style={{ height: share }} />
      </span>
      <span aria-hidden className={cn('absolute top-[12px] hidden h-0.5 bg-[var(--interactive-border-hover)] @xl:block', LINE_INSET[columns])}>
        <span className="absolute inset-y-0 start-0 bg-[var(--status-success)]" style={{ width: share }} />
      </span>
      {steps.map((step, i) => (
        <li
          key={step.name}
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
            {step.name}
          </span>
          <span className="h-4 max-w-full truncate text-[11px] leading-4 text-muted-foreground @xl:mt-0.5" title={step.detail}>{step.detail}</span>
        </li>
      ))}
    </ol>
  );
};

export type VerdictKind = 'ready' | 'checking' | 'idle' | 'failed';

const VERDICT_ICON = {
  failed: { name: 'error-warning', className: 'text-[var(--status-error)]' },
  ready: { name: 'checkbox-circle', className: 'text-[var(--status-success)]' },
  checking: { name: 'loader-4', className: 'animate-spin text-[var(--status-warning)]' },
  idle: { name: 'information', className: 'text-muted-foreground' },
} satisfies Record<VerdictKind, { name: IconName; className: string }>;

type VerdictText = { details: string; copy: string; copied: string };

/**
 * A check's outcome in a line of the interface's language, two lines' room whatever it says. A failure has its
 * diagnostics to show and copy, and `action` where there is a sure way to put it right.
 */
export const Verdict: React.FC<{
  kind: VerdictKind;
  line: string;
  diagnostics: string;
  action?: React.ReactNode;
  text: VerdictText;
}> = ({ kind, line, diagnostics, action, text }) => {
  // Open for the diagnostics it was opened on: a recheck that ends in the same failure shows them again, one that ends
  // in another failure finds them closed.
  const [openFor, setOpenFor] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const failed = kind === 'failed';
  const expanded = failed && openFor === diagnostics;
  return (
    <>
      <div className="mt-4 flex h-[51px] items-center gap-2.5 border-t border-[var(--interactive-border)] pt-3">
        <Icon name={VERDICT_ICON[kind].name} className={cn('size-[18px] shrink-0', VERDICT_ICON[kind].className)} aria-hidden />
        {/* Cut short where a failure's buttons leave it little room; the whole of it on hover. */}
        <p className="typography-meta line-clamp-2 min-w-0 flex-1 text-foreground" title={line}>{line}</p>
        {failed ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {action}
            <Button variant="ghost" size="xs" className="text-muted-foreground" aria-expanded={expanded} onClick={() => setOpenFor(expanded ? null : diagnostics)}>
              {text.details}
            </Button>
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => { void copyTextToClipboard(diagnostics).then((outcome) => setCopied(outcome.ok)); }}>
              {copied ? text.copied : text.copy}
            </Button>
          </div>
        ) : null}
      </div>
      {expanded ? (
        <pre className="typography-micro mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--surface-muted)] p-2 font-mono text-foreground">{diagnostics}</pre>
      ) : null}
    </>
  );
};

/** A check's frame: its steps, then its verdict. */
export const CheckFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-xl border border-[var(--interactive-border)] px-4 pb-3 pt-4">{children}</div>
);

export type Use = { readonly key: string; readonly icon: IconName; readonly tool: string; readonly name: string; readonly text: string };

/** What the agent does with the software, one tile each, faded while it cannot be used; the tool's name on hover. */
export const Uses: React.FC<{ uses: readonly Use[]; ready: boolean; colour: string }> = ({ uses, ready, colour }) => (
  <div className="grid grid-cols-1 gap-2.5 @xl:grid-cols-3">
    {uses.map((use) => (
      <div key={use.key} title={use.tool} className={cn('oc-tile min-w-0 rounded-xl p-3.5 transition-opacity', !ready && 'opacity-55')}>
        <div className="flex items-center gap-2.5">
          <span className="oc-tile-inset flex size-8 shrink-0 items-center justify-center rounded-[9px]" style={{ color: colour }}>
            <Icon name={use.icon} className="size-[17px]" />
          </span>
          <span className="typography-ui-label truncate font-semibold text-foreground">{use.name}</span>
        </div>
        <p className="typography-micro mt-2 truncate text-muted-foreground">{use.text}</p>
      </div>
    ))}
  </div>
);
