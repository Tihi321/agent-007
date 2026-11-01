/** The gate's time source. Tests pass a fake; production uses the real clock (timers are unref'd, so a pending notice never keeps the process alive). */
export interface GateClock {
  now(): number;
  /** Runs `fn` once after `ms`. Returns a function that cancels it. */
  setTimer(ms: number, fn: () => void): () => void;
}

export const realClock: GateClock = {
  now: () => Date.now(),
  setTimer(ms, fn) {
    const t = setTimeout(fn, Math.max(0, ms));
    t.unref?.();
    return () => clearTimeout(t);
  },
};
