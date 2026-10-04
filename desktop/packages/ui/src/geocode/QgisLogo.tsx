import React from 'react';

import logo from './qgis-logo.svg?url';

// The QGIS project's logo. An image, as the app's styles paint every path inside a button in the text colour.
export const QgisLogo: React.FC<{ className?: string }> = ({ className }) => (
  <img src={logo} alt="" draggable={false} className={className} />
);
