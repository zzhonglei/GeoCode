// What a vector layer is drawn in: the same for the same name every time, so that a file looks as it did when it was
// last opened. None of them is near the yellow and the red a picked feature is marked in.
const COLORS = ['#4c8fd6', '#3f9e8f', '#6aa84f', '#b58a3c', '#c7743c', '#b0679f', '#7b74c9', '#5f8aa8'];

export const colorOf = (layer: string): string => {
  let sum = 0;
  for (const letter of layer) sum = (sum * 31 + (letter.codePointAt(0) ?? 0)) % 9973;
  return COLORS[sum % COLORS.length];
};

/** The edge of a polygon and of a point, which tells neighbours of one colour apart. */
export const EDGE = '#232323';

/** What marks the feature that is picked, on the map and in the table. */
export const MARK = '#ffd43b';
export const MARK_EDGE = '#d6336c';
