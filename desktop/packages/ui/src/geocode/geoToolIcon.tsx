import React from 'react';

import { isGeoTool } from './geoTools';
import { QgisLogo } from './QgisLogo';

/** A geo tool's icon, in the colours of the software it works with; undefined for any other tool. */
export const geoToolIcon = (toolName: string, className: string): React.ReactNode | undefined =>
  isGeoTool(toolName) ? <QgisLogo className={className} /> : undefined;
