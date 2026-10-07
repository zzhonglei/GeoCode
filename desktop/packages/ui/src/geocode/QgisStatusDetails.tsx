import React from 'react';

import type { QgisView } from './geoStatus';
import { diagnosticsOf, summaryOf, type QgisText } from './qgisText';
import { StatusFailure } from './StatusFailure';

/** What the indicator's popover and the settings page show of a QGIS status: a line or two, more only on a failure. */
export const QgisStatusDetails: React.FC<{
  status: QgisView;
  text: QgisText;
  /** False on the settings page, which lists the app itself. */
  withApp?: boolean;
}> = ({ status, text, withApp = true }) => {
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

  const message = 'diagnostics' in status ? status.diagnostics.message : null;
  return <StatusFailure message={message} diagnostics={diagnosticsOf(status)} text={text} />;
};
