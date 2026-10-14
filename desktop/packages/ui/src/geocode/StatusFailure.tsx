import React from 'react';

import { copyTextToClipboard } from '@/lib/clipboard';
import type { QgisText } from './qgisText';

const LINK_CLASS = 'typography-micro rounded px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover hover:text-foreground';

/** A failure as every environment shows it: the error itself, then its diagnostics on demand, to read or copy. */
export const StatusFailure: React.FC<{
  message: string | null;
  diagnostics: string;
  text: Pick<QgisText, 'details' | 'copy' | 'copied'>;
}> = ({ message, diagnostics, text }) => {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const handleCopy = async () => setCopied((await copyTextToClipboard(diagnostics)).ok);

  return (
    <div className="min-w-0 space-y-1">
      {message ? <p className="typography-meta break-words text-foreground">{message}</p> : null}
      <div className="-ms-1.5 flex items-center gap-1">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)} className={LINK_CLASS}>
          {text.details}
        </button>
        <button type="button" onClick={() => { void handleCopy(); }} className={LINK_CLASS}>
          {copied ? text.copied : text.copy}
        </button>
      </div>
      {expanded ? (
        <pre className="typography-micro max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--surface-muted)] p-2 font-mono text-foreground">{diagnostics}</pre>
      ) : null}
    </div>
  );
};
