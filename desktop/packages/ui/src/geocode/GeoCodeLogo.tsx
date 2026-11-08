import React from 'react';

import logo from './geocode-logo.svg?url';

// GeoCode's mark: the app icon's, without its tile. An image, as QgisLogo is.
export const GeoCodeLogo: React.FC<{ className?: string }> = ({ className }) => (
  <img src={logo} alt="" draggable={false} className={className} />
);
