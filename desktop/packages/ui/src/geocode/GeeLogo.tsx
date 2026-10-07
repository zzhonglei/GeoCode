import React from 'react';

import logo from './gee-logo.svg?url';

// Google Earth Engine's logo, as GeoCode's first version showed it. An image, as QgisLogo is.
export const GeeLogo: React.FC<{ className?: string }> = ({ className }) => (
  <img src={logo} alt="" draggable={false} className={className} />
);
