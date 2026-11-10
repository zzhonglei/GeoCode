import React from 'react';

import wordmark from './geocode-wordmark.svg?url';

/**
 * GeoCode's wordmark heading the new session, set apart from the composer below, whose placeholder asks the question
 * (cut off where a long project name takes it past one line, as in the mini chat). Pixel art drawn on a 512 × 112
 * grid, shown at three quarters of it, about two thirds of the composer's width. Left out on a window too short to hold
 * it. One drawing serves both themes.
 */
export const DraftWordmark: React.FC = () => (
  <img
    src={wordmark}
    alt=""
    aria-hidden="true"
    draggable={false}
    width={384}
    height={84}
    className="mx-auto mb-4 block h-auto max-w-full select-none [@media(max-height:620px)]:hidden"
  />
);
