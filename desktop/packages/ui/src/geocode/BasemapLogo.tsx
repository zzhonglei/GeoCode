import React from 'react';

import logo from './basemap-logo.svg?url';

// GeoCode's mark for the basemap: a map under a layer of data. An image, as QgisLogo is.
export const BasemapLogo: React.FC<{ className?: string }> = ({ className }) => (
  <img src={logo} alt="" draggable={false} className={className} />
);
