import React from 'react';

import earth from './earth.svg?url';

// A globe, for reading geographic data. An image, as QgisLogo is.
export const EarthIcon: React.FC<{ className?: string }> = ({ className }) => (
  <img src={earth} alt="" draggable={false} className={className} />
);
