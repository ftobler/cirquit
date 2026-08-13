/** The one-shot startup auto-pause, wired to window and the store. All the
 *  logic lives in `autoPause.ts`, which is node-tested; like `useFocusTrap`,
 *  this hook is the thin DOM wiring and is untested by construction. */

import { useEffect } from 'react';
import { useStore } from '../state/store';
import { armAutoPause } from './autoPause';

/** Pauses the sim after 10 s without a meaningful input, once, at startup. The
 *  listeners sit on window, so a dialog, the menubar or the canvas all count
 *  as input, and inputs during the initial wasm-engine load cancel the pause
 *  too (the effect does not wait for the engine). */
export function useAutoPause(): void {
  useEffect(() => {
    const stop = armAutoPause({
      addEventListener: (type, listener) => window.addEventListener(type, listener),
      removeEventListener: (type, listener) => window.removeEventListener(type, listener),
      getRunning: () => useStore.getState().running,
      setRunning: (running) => useStore.getState().setRunning(running),
    });
    return stop;
  }, []);
}
