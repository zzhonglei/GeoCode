import React from 'react';

import { geeDiagnosticsOf, geeMessageOf } from './geeText';
import type { GeeView } from './geoStatus';
import type { QgisText } from './qgisText';
import { StatusFailure } from './StatusFailure';

/**
 * As QgisStatusDetails, for Google Earth Engine: the project it uses, or what is wrong. The Python is GeoCode's own,
 * so it is not shown.
 */
export const GeeStatusDetails: React.FC<{
  status: GeeView;
  text: Pick<QgisText, 'details' | 'copy' | 'copied'>;
}> = ({ status, text }) => {
  if (status.status === 'ready' || status.status === 'checking') {
    return status.project ? (
      <p className="typography-meta truncate text-muted-foreground" title={status.project}>{status.project}</p>
    ) : null;
  }

  const message = 'diagnostics' in status ? geeMessageOf(status) : null;
  return <StatusFailure message={message} diagnostics={geeDiagnosticsOf(status)} text={text} />;
};
