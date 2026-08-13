import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_PAUSE_EVENTS, AUTO_PAUSE_MS, armAutoPause } from './autoPause';
import { useStore } from '../state/store';

/** A fake event target the helper can listen on and the test can drive. The
 *  listeners are stored per event type so the test can also assert the helper
 *  cleaned up after itself. */
function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatch: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    /** Live listener count for an event type, so a test can prove the disarm. */
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

/** The store-backed wiring the hook itself uses, minus the window. */
function wire() {
  const target = fakeTarget();
  const stop = armAutoPause({
    addEventListener: target.addEventListener,
    removeEventListener: target.removeEventListener,
    getRunning: () => useStore.getState().running,
    setRunning: (running) => useStore.getState().setRunning(running),
  });
  return { target, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The store is a module singleton; each test starts with the sim running,
  // the same default the store initialiser gives a fresh page.
  useStore.setState({ running: true });
});

afterEach(() => vi.useRealTimers());

describe('armAutoPause', () => {
  it('registers one listener per tracked event', () => {
    const { target } = wire();
    for (const type of AUTO_PAUSE_EVENTS) {
      expect(target.count(type)).toBe(1);
    }
  });

  it('pauses the sim at the deadline with no input', () => {
    wire();
    expect(useStore.getState().running).toBe(true);
    vi.advanceTimersByTime(AUTO_PAUSE_MS - 1);
    expect(useStore.getState().running).toBe(true);
    vi.advanceTimersByTime(1);
    expect(useStore.getState().running).toBe(false);
  });

  it('an input before the deadline cancels the timer and never pauses', () => {
    const { target } = wire();
    vi.advanceTimersByTime(5000);
    target.dispatch('pointerdown');
    // The input disarmed the helper, so no listener is left to catch anything.
    expect(target.count('click')).toBe(0);
    vi.advanceTimersByTime(AUTO_PAUSE_MS * 10);
    expect(useStore.getState().running).toBe(true);
  });

  it('every tracked event counts as input', () => {
    for (const type of AUTO_PAUSE_EVENTS) {
      const { target } = wire();
      target.dispatch(type);
      vi.advanceTimersByTime(AUTO_PAUSE_MS * 10);
      expect(useStore.getState().running).toBe(true);
    }
  });

  it('pointermove is not a tracked event: a stray cursor does not cancel the pause', () => {
    const { target } = wire();
    target.dispatch('pointermove');
    vi.advanceTimersByTime(AUTO_PAUSE_MS * 10);
    expect(useStore.getState().running).toBe(false);
  });

  it('the pause is one-shot: later idle time does nothing and a re-run is not paused again', () => {
    const { target } = wire();
    vi.advanceTimersByTime(AUTO_PAUSE_MS);
    expect(useStore.getState().running).toBe(false);
    // Idle time after the pause fires nothing.
    vi.advanceTimersByTime(AUTO_PAUSE_MS * 10);
    expect(useStore.getState().running).toBe(false);
    // A user re-run must not be paused again, by time or by a later input.
    useStore.getState().setRunning(true);
    vi.advanceTimersByTime(AUTO_PAUSE_MS * 10);
    expect(useStore.getState().running).toBe(true);
    target.dispatch('click');
    vi.advanceTimersByTime(AUTO_PAUSE_MS * 10);
    expect(useStore.getState().running).toBe(true);
  });

  it('a timer that fires against an already-paused sim is a no-op', () => {
    wire();
    // A stop trigger pauses without any of the tracked input events, so the
    // timer stays armed; when it lands the sim is already paused and must not
    // be touched again.
    useStore.getState().setRunning(false);
    vi.advanceTimersByTime(AUTO_PAUSE_MS);
    expect(useStore.getState().running).toBe(false);
  });

  it('the stop handle clears the timer and removes every listener', () => {
    const { target, stop } = wire();
    stop();
    for (const type of AUTO_PAUSE_EVENTS) {
      expect(target.count(type)).toBe(0);
    }
    vi.advanceTimersByTime(AUTO_PAUSE_MS * 10);
    expect(useStore.getState().running).toBe(true);
  });

  it('a remount after stop re-arms a fresh pause window', () => {
    const first = wire();
    first.stop();
    // A strict-mode unmount/remount must not leave the previous arm in charge:
    // the fresh arm gets its own 10 s and still pauses.
    wire();
    expect(useStore.getState().running).toBe(true);
    vi.advanceTimersByTime(AUTO_PAUSE_MS);
    expect(useStore.getState().running).toBe(false);
    // The old arm's listeners stayed off its target.
    for (const type of AUTO_PAUSE_EVENTS) {
      expect(first.target.count(type)).toBe(0);
    }
  });
});
