/** The one-shot startup auto-pause. A freshly opened tab runs the sim by
 *  default, and an unattended tab would burn CPU forever, so the sim pauses
 *  after `AUTO_PAUSE_MS` of no real user input. The logic is pure and DOM-free:
 *  the timer and the event listeners are injected, so the whole thing is
 *  testable under node. The React half is `useAutoPause.ts`. */

/** Idle time before an unattended tab pauses, in ms. */
export const AUTO_PAUSE_MS = 10000;

/** Window events that count as the user being present. A pointermove or a
 *  hover must not count: a stray cursor is not intent, so it must not cancel
 *  the pause. A dialog, the menubar or the canvas all produce one of these,
 *  so they cancel the pause too. */
export const AUTO_PAUSE_EVENTS = [
  'pointerdown',
  'keydown',
  'wheel',
  'touchstart',
  'click',
] as const;

/** The injectable timer backend. The handle is opaque so the module never
 *  couples to the browser's numeric id or node's Timeout object. */
export interface AutoPauseTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ArmAutoPauseOptions {
  /** Idle time before the pause; defaults to AUTO_PAUSE_MS. */
  delayMs?: number;
  /** The timer backend; defaults to globalThis, which vitest fake timers
   *  intercept. */
  timers?: AutoPauseTimers;
  /** Where the input events are listened for. The hook passes window; tests
   *  pass a fake target. */
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  /** Reads whether the sim is still running when the deadline lands, so a
   *  timer that fires against an already-paused sim (a stop trigger, a manual
   *  pause outside the tracked events) is a no-op. */
  getRunning?: () => boolean;
  /** The pause action, injected so the module never imports the store. */
  setRunning: (running: boolean) => void;
}

/** Arms the one-shot pause, returning a stop handle that clears the timer and
 *  removes the listeners. The first meaningful input or the deadline settles
 *  it; after that it never arms again, so a user who re-runs after the pause
 *  is not re-paused and the effect never fights the run button. */
export function armAutoPause(options: ArmAutoPauseOptions): () => void {
  const {
    delayMs = AUTO_PAUSE_MS,
    addEventListener,
    removeEventListener,
    getRunning = () => true,
    setRunning,
  } = options;
  // The default backend is globalThis, so vitest fake timers (which replace
  // its setTimeout/clearTimeout) drive the deadline in tests. The adapter
  // keeps the opaque handle out of the global signatures.
  const timers: AutoPauseTimers =
    options.timers ?? {
      setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
    };

  // Settled means an input cancelled the deadline or the deadline fired. Once
  // settled the helper is inert for the life of the effect.
  let settled = false;
  let timer: unknown | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const disarm = () => {
    for (const type of AUTO_PAUSE_EVENTS) {
      removeEventListener(type, onInput);
    }
  };

  const fire = () => {
    if (settled) return;
    settled = true;
    cancelTimer();
    disarm();
    if (getRunning()) setRunning(false);
  };

  const onInput = () => {
    if (settled) return;
    settled = true;
    cancelTimer();
    disarm();
  };

  timer = timers.setTimeout(fire, delayMs);
  for (const type of AUTO_PAUSE_EVENTS) {
    addEventListener(type, onInput);
  }

  return () => {
    settled = true;
    cancelTimer();
    disarm();
  };
}
