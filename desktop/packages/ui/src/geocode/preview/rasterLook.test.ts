import { describe, expect, test } from 'bun:test';

import { BY_CLASS, type Measured } from './previewClient';
import { bandLook, drawnColour } from './rasterLook';

const BAND: Measured = { min: 0, max: 1000, mean: 400, std: 120, low: 20, high: 900, between: [20, 900], counts: [1, 2, 3], edges: [0, 1000] };
const CLASSES = [{ value: 10, color: [0, 100, 0, 255], share: 1, name: null }];

// The pixel tab shows the colour a value is drawn in; worked out apart from the reader, it must come out as the
// reader's (`_ramp` and `tile` in geoengine/python/geocodekit/preview/_raster.py), or a pixel would be said to be
// another colour than the map shows it in.
describe('GeoCode: the colour of a pixel is the one the map draws it in', () => {
  test('a value is scaled to one of 256 steps, down to the step below it', () => {
    expect(drawnColour(127.5, [0, 255], ['#000000', '#ffffff'])).toBe('rgb(127 127 127)');
  });

  test('past the range, a value is the colour of the ramp at that end', () => {
    expect(drawnColour(-50, [0, 100], ['#2b6654', '#e3de8c', '#f7f7f7'])).toBe('rgb(43 102 84)');
    expect(drawnColour(150, [0, 100], ['#2b6654', '#e3de8c', '#f7f7f7'])).toBe('rgb(247 247 247)');
  });

  test('without a range a value is drawn as it is, between 0 and 255', () => {
    expect(drawnColour(300, null, ['#000000', '#ffffff'])).toBe('rgb(255 255 255)');
    expect(drawnColour(64, null, ['#000000', '#ffffff'])).toBe('rgb(64 64 64)');
  });

  test('a ramp of several colours passes through each of them evenly', () => {
    // The middle of three colours, at step 127 of 255, just short of it.
    expect(drawnColour(127, [0, 255], ['#000000', '#c8c8c8', '#ffffff'])).toBe('rgb(199 199 199)');
  });
});

describe('GeoCode: a band drawn alone is drawn as the reader draws it when left to itself', () => {
  test('by its classes where it has them, else in grey between the range the reader chose', () => {
    expect(bandLook(BAND, CLASSES, null)).toEqual({ ramp: BY_CLASS, classed: true, range: [20, 900] });
    expect(bandLook(BAND, null, null)).toEqual({ ramp: 'grey', classed: false, range: [20, 900] });
  });

  test('else through the ramp and between the range the preview names, or as it is with none', () => {
    expect(bandLook(BAND, CLASSES, { bands: [1], ramp: 'terrain', ranges: [[0, 500]] })).toEqual({ ramp: 'terrain', classed: false, range: [0, 500] });
    expect(bandLook(BAND, null, { bands: [1], ramp: 'grey' })).toEqual({ ramp: 'grey', classed: false, range: null });
  });
});
