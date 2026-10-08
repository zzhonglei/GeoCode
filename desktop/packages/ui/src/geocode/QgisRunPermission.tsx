import React from 'react';
import { z } from 'zod';

import { Icon } from '@/components/icon/Icon';
import { useI18nStore } from '@/lib/i18n';
import { cn, formatPathForDisplay } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import type { PermissionRequest } from '@/types/permission';

import { geoCardText, qgisAlgorithm, qgisAlgorithmText } from './geoTools';

/** A parameter's value as the card writes it: text as it is, anything else as JSON. */
const shown = z.union([z.string(), z.json().transform((value) => JSON.stringify(value))]);

const entry = z.object({ name: z.string(), value: shown });

/** What the kernel tells the card about a run, in its asking's metadata. */
const asking = z.object({
  description: z.string().trim().min(1).optional().catch(undefined),
  algorithm: qgisAlgorithm.optional().catch(undefined),
  inputs: z.array(entry).catch([]),
  options: z.array(entry).catch([]),
  outputs: z
    .array(entry.extend({ external: z.boolean().catch(false), place: z.string().optional().catch(undefined) }))
    .catch([]),
  external: z.array(z.string()).catch([]),
  elsewhere: z.array(z.string()).catch([]),
  guarded: z.boolean().catch(false),
});

const LINE_CLASS = 'typography-meta min-w-0 truncate whitespace-nowrap';

/** A line of a geo tool's permission card: its label, then the value, cut short where it runs long. */
export const Labelled: React.FC<{
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}> = ({ label, children, mono }) => (
  <div className={cn(LINE_CLASS, 'text-foreground', mono && 'font-mono')}>
    <span className={cn('text-muted-foreground', mono ? 'mr-2 font-sans' : undefined)}>{label}</span>
    {children}
  </div>
);

const Warning: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="typography-meta flex items-start gap-1.5 text-[var(--status-warning)]">
    <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0" />
    <span className="min-w-0 break-words">{children}</span>
  </div>
);

/**
 * qgisrun's permission card, line by line: why GeoAgent asks, what the algorithm does, what to heed, then its inputs,
 * parameters and outputs a line each, cut short where they run long. An output outside the project, or one that is no
 * file, shows in the warning colour.
 */
export const QgisRunPermission: React.FC<{ permission: PermissionRequest }> = ({ permission }) => {
  // Subscribed so the card follows a change of language.
  const locale = useI18nStore((state) => state.locale);
  const home = useDirectoryStore((state) => state.homeDirectory);
  const parsed = asking.safeParse(permission.metadata ?? {});
  if (!parsed.success) return null;
  const run = parsed.data;
  const text = geoCardText(locale);
  const algorithm = run.algorithm && qgisAlgorithmText(run.algorithm, locale);
  const colon = text.colon;
  const path = (value: string) => formatPathForDisplay(value, home);
  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 py-2">
      {run.description ? <Labelled label={`${text.reason}${colon}`}>{run.description}</Labelled> : null}
      {algorithm?.description ? <Labelled label={`${text.purpose}${colon}`}>{algorithm.description}</Labelled> : null}
      {run.external.map((directory) => (
        <Warning key={directory}>{text.outside(formatPathForDisplay(directory, home))}</Warning>
      ))}
      {run.elsewhere.map((target) => (
        <Warning key={target}>{text.elsewhere(target)}</Warning>
      ))}
      {run.guarded ? <Warning>{text.guarded}</Warning> : null}
      {run.inputs.length ? (
        <Labelled label={text.input} mono>
          {run.inputs.map((input) => path(input.value)).join(', ')}
        </Labelled>
      ) : null}
      {run.options.length ? (
        <Labelled label={text.parameters} mono>
          {run.options.map((option) => `${option.name}=${option.value}`).join(', ')}
        </Labelled>
      ) : null}
      {run.outputs.length ? (
        <Labelled label={text.output} mono>
          {run.outputs.map((output, index) => (
            <React.Fragment key={output.name}>
              {index > 0 ? ', ' : null}
              <span className={output.external || output.place ? 'text-[var(--status-warning)]' : undefined}>
                {path(output.value)}
              </span>
            </React.Fragment>
          ))}
        </Labelled>
      ) : null}
    </div>
  );
};
