import React from 'react';

import { geeDiagnosticsOf, geeMessageOf, geeSummaryOf } from './geeText';
import type { GeeView } from './geoStatus';
import type { QgisText } from './qgisText';
import { StatusFailure } from './StatusFailure';

/** As QgisStatusDetails, for Google Earth Engine: the project and versions it runs with, or what is wrong. */
export const GeeStatusDetails: React.FC<{
  status: GeeView;
  text: Pick<QgisText, 'details' | 'copy' | 'copied'>;
}> = ({ status, text }) => {
  if (status.status === 'ready') {
    const summary = geeSummaryOf(status);
    return (
      <div className="min-w-0">
        <p className="typography-meta truncate text-muted-foreground" title={summary}>{summary}</p>
        <p className="typography-micro truncate font-mono text-muted-foreground" title={status.python}>{status.python}</p>
      </div>
    );
  }
  if (status.status === 'checking') {
    return <p className="typography-micro truncate font-mono text-muted-foreground" title={status.python}>{status.python}</p>;
  }
  if (status.status === 'unconfigured') return null;

  const message = 'diagnostics' in status ? geeMessageOf(status) : null;
  return <StatusFailure message={message} diagnostics={geeDiagnosticsOf(status)} text={text} />;
};
