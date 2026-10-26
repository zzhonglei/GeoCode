import React from 'react';

import { EarthIcon } from './EarthIcon';
import { GeeLogo } from './GeeLogo';
import { isGeoTool } from './geoTools';
import { OsmLogo } from './OsmLogo';
import { isOsmTool } from './osmView';
import { QgisLogo } from './QgisLogo';

/** A geo tool's icon, in colour; undefined for any other tool. */
export const geoToolIcon = (toolName: string, className: string): React.ReactNode | undefined => {
  if (toolName === 'geerun') return <GeeLogo className={className} />;
  if (isOsmTool(toolName)) return <OsmLogo className={className} />;
  if (!isGeoTool(toolName)) return undefined;
  return toolName === 'readgeodata' ? <EarthIcon className={className} /> : <QgisLogo className={className} />;
};
