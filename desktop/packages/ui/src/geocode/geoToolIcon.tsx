import React from 'react';

import { EarthIcon } from './EarthIcon';
import { isGeoTool } from './geoTools';
import { QgisLogo } from './QgisLogo';

/** A geo tool's icon, in colour; undefined for any other tool. */
export const geoToolIcon = (toolName: string, className: string): React.ReactNode | undefined => {
  if (!isGeoTool(toolName)) return undefined;
  return toolName === 'readgeodata' ? <EarthIcon className={className} /> : <QgisLogo className={className} />;
};
