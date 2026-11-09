import React from 'react';

import wordmark from './geocode-wordmark.svg?url';

/**
 * GeoCode's wordmark heading the new session, with the question under it as its subtitle: one group, the wordmark
 * first, set apart from the composer below. Pixel art drawn on a 512 × 112 grid, shown at three quarters of it, about
 * two thirds of the composer's width: at half it looked slight beside the composer, at the full size it reads as a
 * banner. Left out on a window too short to hold it. One drawing serves both themes.
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

/** The question under the wordmark: smaller and quieter than a heading, its project name in the text's own colour. */
export const DRAFT_SUBTITLE_CLASS =
  'text-balance text-lg font-normal text-muted-foreground md:text-xl [&>span]:font-semibold [&>span]:text-foreground';
