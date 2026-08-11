import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from './store';
import { fresh } from './store.test-helpers';

/** The frame-loop seam as useStoreRef wires it: a ref seeded from the store's
 *  current state, kept live by one subscription made at mount, and never
 *  re-bound. A dev reload that swapped the store instance would leave this
 *  ref on the old, now-frozen instance. */
function attachFrameRef(store: typeof useStore): {
  ref: { current: ReturnType<typeof store.getState> };
  unsubscribe: () => void;
} {
  const ref = { current: store.getState() };
  const unsubscribe = store.subscribe((s) => {
    ref.current = s;
  });
  return { ref, unsubscribe };
}

describe('the store survives a dev reload', () => {
  beforeEach(() => useStore.setState(fresh()));

  it('re-evaluating the module returns the same instance', async () => {
    // A dev reload re-executes store.ts (it imports the element registry).
    // The instance the reload produces must be the one everything else reads,
    // not a second store that orphans the frame loop's subscription.
    vi.resetModules();
    const { useStore: reloaded } = await import('./store');
    expect(reloaded).toBe(useStore);
  });

  it('a paused sim restarts via the button after the instance is replaced', async () => {
    useStore.getState().setRunning(false);
    const { ref, unsubscribe } = attachFrameRef(useStore);
    expect(ref.current.running).toBe(false);

    // The dev-time reload: store.ts re-evaluates, replacing the store
    // instance the frame loop's useStoreRef is subscribed to.
    vi.resetModules();
    const { useStore: reloaded } = await import('./store');

    // The Run button toggles `running` on the current store.
    reloaded.getState().toggleRunning();

    // The frame loop keeps reading through its original subscription, so the
    // restart must be visible on the shared instance.
    expect(ref.current.running).toBe(true);
    unsubscribe();
  });
});
