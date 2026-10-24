import React from 'react';

import { GeeQuotaCard } from './GeeQuota';
import { geeDiagnosticsOf, geeMessageOf, type GeeText } from './geeText';
import type { GeeView } from './geoStatus';
import type { QgisText } from './qgisText';
import { StatusFailure } from './StatusFailure';

/**
 * As QgisStatusDetails, for Google Earth Engine: the project it uses, or what is wrong. The Python is GeoCode's own,
 * so it is not shown. Given `quota`, which only the status card gives, a ready project's monthly quota follows; it
 * stays while the same project is checked again, so the card keeps its height.
 */
export const GeeStatusDetails: React.FC<{
  status: GeeView;
  text: Pick<QgisText, 'details' | 'copy' | 'copied'>;
  quota?: GeeText['quota'];
}> = ({ status, text, quota }) => {
  // The project last found ready while this is shown; written as it renders, as usePythonOverlay's note is.
  const ready = React.useRef<string | undefined>(undefined);
  if (status.status === 'ready') ready.current = status.project;
  else if (status.status !== 'checking') ready.current = undefined;

  if (status.status === 'ready' || status.status === 'checking') {
    const project = status.project ? (
      <p className="typography-meta truncate text-muted-foreground" title={status.project}>{status.project}</p>
    ) : null;
    return quota && status.project && status.project === ready.current ? (
      <>
        {project}
        <GeeQuotaCard project={status.project} text={quota} />
      </>
    ) : project;
  }

  const message = 'diagnostics' in status ? geeMessageOf(status) : null;
  return <StatusFailure message={message} diagnostics={geeDiagnosticsOf(status)} text={text} />;
};
