import React from 'react';

import logo from './osm-logo.svg?url';

// OpenStreetMap's magnifying glass, the OSM Foundation's logo (docs/OSM.md, section 9). An image, as
// QgisLogo is.
export const OsmLogo: React.FC<{ className?: string }> = ({ className }) => (
  <img src={logo} alt="" draggable={false} className={className} />
);
