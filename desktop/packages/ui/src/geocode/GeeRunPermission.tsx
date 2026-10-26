import React from 'react';
import { z } from 'zod';

import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { useI18nStore } from '@/lib/i18n';
import { formatPathForDisplay } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import type { PermissionRequest } from '@/types/permission';

import { excerptOf, geoCardText } from './geoTools';
import { Labelled } from './QgisRunPermission';

/** What the kernel tells the card about a run, in its asking's metadata: the script, or the file it runs. */
const asking = z.object({
  description: z.string().trim().min(1).optional().catch(undefined),
  script: z.string().optional().catch(undefined),
  path: z.string().min(1).optional().catch(undefined),
});

// Flush with the card's lines, without a box of its own.
const EXCERPT_STYLE: React.CSSProperties = {
  background: 'transparent',
  fontSize: 'var(--text-meta)',
  lineHeight: '1.25rem',
};

/** geerun's permission card: why GeoAgent asks, then the first lines of the script, or the file it runs. */
export const GeeRunPermission: React.FC<{ permission: PermissionRequest }> = ({ permission }) => {
  // Subscribed so the card follows a change of language.
  const locale = useI18nStore((state) => state.locale);
  const home = useDirectoryStore((state) => state.homeDirectory);
  const parsed = asking.safeParse(permission.metadata ?? {});
  if (!parsed.success) return null;
  const run = parsed.data;
  const text = geoCardText(locale);
  const excerpt = excerptOf(run.script ?? '');
  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 py-2">
      {run.description ? <Labelled label={`${text.reason}${text.colon}`}>{run.description}</Labelled> : null}
      {excerpt.shown ? (
        <div className="min-w-0">
          <WorkerHighlightedCode
            code={excerpt.shown}
            language="python"
            // A long line is cut short rather than scrolled.
            className="[&_pre]:overflow-hidden [&_pre]:text-ellipsis"
            style={EXCERPT_STYLE}
          />
          {excerpt.rest ? <div className="typography-micro text-muted-foreground">{text.rest(excerpt.rest)}</div> : null}
        </div>
      ) : null}
      {run.path ? (
        <Labelled label={text.file} mono wrap>
          {formatPathForDisplay(run.path, home)}
        </Labelled>
      ) : null}
    </div>
  );
};
