// Milliseconds without a call after which the calls are taken to have stopped: longer than a frame of a slide, so
// that a slide's frames count as one run of calls, and too short to be felt as a wait after a single change.
const STILL = 90;

/**
 * `task` run once the calls for it have stopped. What follows a size must not follow it through every frame of a
 * panel sliding: a map is drawn whole again for each size it is given, and the slide drops frames for it. The app
 * says so for the slides of its side panels alone (`runWhenLayoutSettled`); the file tree's opening is one it does
 * not say.
 */
export const stilled = (task: () => void) => {
  let waiting: ReturnType<typeof setTimeout> | null = null;
  const drop = () => {
    if (waiting !== null) clearTimeout(waiting);
    waiting = null;
  };
  return {
    ask: () => {
      drop();
      waiting = setTimeout(() => {
        waiting = null;
        task();
      }, STILL);
    },
    drop,
  };
};
