import React from 'react';

import { copyTextToClipboard } from '@/lib/clipboard';
import type { QgisView } from './geoStatus';
import { diagnosticsOf, summaryOf, type QgisText } from './qgisText';

const LINK_CLASS = 'typography-micro rounded px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover hover:text-foreground';

/** What the indicator's popover and the settings page show of a QGIS status: a line or two, more only on a failure. */
export const QgisStatusDetails: React.FC<{
  status: QgisView;
  text: QgisText;
  /** False on the settings page, which lists the app itself. */
  withApp?: boolean;
}> = ({ status, text, withApp = true }) => {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  if (status.status === 'ready') {
    const summary = summaryOf(status, text);
    return (
      <div className="min-w-0">
        <p className="typography-meta truncate text-muted-foreground" title={summary}>{summary}</p>
        {withApp ? <p className="typography-micro truncate font-mono text-muted-foreground" title={status.app}>{status.app}</p> : null}
      </div>
    );
  }
  if (status.status === 'checking') {
    return withApp ? <p className="typography-micro truncate font-mono text-muted-foreground" title={status.path}>{status.path}</p> : null;
  }
  if (status.status === 'unconfigured') return null;

  const diagnostics = diagnosticsOf(status);
  const message = 'diagnostics' in status ? status.diagnostics.message : null;
  const handleCopy = async () => setCopied((await copyTextToClipboard(diagnostics)).ok);

  return (
    <div className="min-w-0 space-y-1">
      {message ? <p className="typography-meta break-words text-foreground">{message}</p> : null}
      <div className="-ml-1.5 flex items-center gap-1">
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
