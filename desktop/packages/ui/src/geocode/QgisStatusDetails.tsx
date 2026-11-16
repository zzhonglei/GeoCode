import React from 'react';

import type { QgisView } from './geoStatus';
import { diagnosticsOf, summaryOf, type QgisText } from './qgisText';
import { StatusFailure } from './StatusFailure';

/** What the indicator's popover shows of a QGIS status: a line or two, more only on a failure. */
export const QgisStatusDetails: React.FC<{ status: QgisView; text: QgisText }> = ({ status, text }) => {
  if (status.status === 'ready') {
    const summary = summaryOf(status, text);
    return (
      <div className="min-w-0">
        <p className="typography-meta truncate text-muted-foreground" title={summary}>{summary}</p>
        <p className="typography-micro truncate font-mono text-muted-foreground" title={status.app}>{status.app}</p>
      </div>
    );
  }
  if (status.status === 'checking') {
    return <p className="typography-micro truncate font-mono text-muted-foreground" title={status.path}>{status.path}</p>;
  }
  if (status.status === 'unconfigured') return null;

  const message = 'diagnostics' in status ? status.diagnostics.message : null;
  return <StatusFailure message={message} diagnostics={diagnosticsOf(status)} text={text} />;
};
