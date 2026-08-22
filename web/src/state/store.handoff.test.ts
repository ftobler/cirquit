import { beforeEach, describe, expect, it } from 'vitest';
import { postsOf } from '../model/registry';
import type { CircuitElement } from '../model/types';
import { useStore } from './store';
import { addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

/**
 * Mirrors the element-spec construction in `SimEngine.setCircuit`
 * (simulator.ts): posts rounded at the boundary, non-finite params dropped.
 * Kept in sync with the simulator on purpose, so the handoff contract is
 * pinned without loading wasm.
 */
function elementSpecs(elements: CircuitElement[]) {
  return elements.map((e) => {
    const params = { ...e.params };
    // Mirrors the simulator's session-only strip (simulator.ts): the switch2
    // flip parity never crosses into the engine spec.
    delete params.flipParity;
    if (e.state !== undefined) params[e.kind === 'fuse' ? 'blown' : 'position'] = e.state;
    return {
      id: e.id,
      kind: e.kind,
      posts: postsOf(e).map((p) => [Math.round(p.x), Math.round(p.y)]),
      params: Object.fromEntries(
        Object.entries(params).filter(([, v]) => Number.isFinite(v)),
      ),
      label: e.text ?? null,
      flags: e.flags,
    };
  });
}

describe('the engine handoff contract', () => {
  it('the serialised spec carries only integer coordinates', () => {
    // A drag with the fractional delta the old canvas path produced, then the
    // spec builder the engine sees. The JSON handed to serde must contain no
    // fractional post: that is what makes `[i32; 2]` reject a bad circuit.
    const id = addResistor();
    useStore.getState().select([id]);
    for (let i = 0; i < 10; i++) {
      useStore.getState().moveElements([id], 0.3, 1.7);
    }

    const json = JSON.stringify({ elements: elementSpecs(useStore.getState().elements) });
    expect(json).not.toMatch(/\[\s*-?\d+\.\d+/);

    const parsed = JSON.parse(json) as {
      elements: { posts: [number, number][] }[];
    };
    for (const el of parsed.elements) {
      for (const [x, y] of el.posts) {
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
      }
    }
  });

  it('a non-finite param is dropped, never serialised as null', () => {
    // Bypass the setParam guard by writing the NaN straight into the element,
    // as a future input path that forgets the guard would.
    const id = addResistor();
    useStore.getState().updateElement(id, { params: { resistance: 1000, foo: NaN } });

    const json = JSON.stringify({ elements: elementSpecs(useStore.getState().elements) });
    const parsed = JSON.parse(json) as {
      elements: { params: Record<string, number> }[];
    };
    for (const el of parsed.elements) {
      expect(Object.values(el.params)).not.toContain(null);
      expect(Object.values(el.params).every((v) => Number.isFinite(v))).toBe(true);
    }
    // The NaN param is gone entirely, so `JSON.stringify` could not have
    // emitted it as `null` inside the params object.
    expect(parsed.elements[0].params.foo).toBeUndefined();
  });

  it('a switch2 flip parity never reaches the spec, while the link does', () => {
    // flipParity is session-only (upstream's positionFlipped, Switch2Elm.java:
    // 244), so the handoff strips it; `link` is the stored truth of the S line
    // and must ride for the engine's future use.
    const id = useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, throwCount: 2, link: 7, flipParity: 1 },
      state: 0,
    });
    const [el] = elementSpecs(useStore.getState().elements);
    expect(el.id).toBe(id);
    expect(el.params.flipParity).toBeUndefined();
    expect(el.params.link).toBe(7);
    expect(el.params.position).toBe(0);
  });
});
