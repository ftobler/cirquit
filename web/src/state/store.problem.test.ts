import { beforeEach, describe, expect, it } from 'vitest';
import { mergeProblem, useStore } from './store';
import { fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

// `999` is the corpus's canonical unknown element code: this build does not
// construct it, so the parse reports it unsupported and the load sets the
// missing-components banner. A future upstream element code arrives the same
// way, through the same `describeMissing` path.
const UNSUPPORTED = '$ 1 0.000005 10 50 5 50 5e-11\n999 0 0 32 0 0 1\n';
const MISSING_MESSAGE =
  '1 element type(s) (999) are not implemented yet, so those components are ' +
  'missing from the drawing and the simulation.';
// An `h` hint line rides through the load untouched: nothing is lost, so it
// takes the notice channel instead of the banner. Every upstream file that
// carries one would otherwise open on a permanent banner.
const INERT = '$ 1 0.000005 10 50 5 50 5e-11\nr 0 0 16 0 0 100\nh 1 4 3\n';
const INERT_MESSAGE = '1 other line type(s) (h) were preserved but not interpreted.';
// The engine's floating-node warning wording (circuit.rs:871-873).
const FLOATING_WARNING =
  '1 floating node(s) have no path to ground; they were pinned with a 100 MΩ resistance.';
const CLEAN = '$ 1 0.000005 10 50 5 50 5e-11\nr 0 0 16 0 0 100\n';

describe('the load-time unsupported message survives the frame-loop merge', () => {
  it('a load with an unported element line sets the banner', () => {
    useStore.getState().loadNetlist(UNSUPPORTED);
    const s = useStore.getState();
    expect(s.problem).toBe(MISSING_MESSAGE);
    expect(s.unsupportedProblem).toBe(MISSING_MESSAGE);
  });

  it('the message survives when the engine reports no warnings', () => {
    // The first engine build reports no warnings for most circuits, which used
    // to set problem to null and wipe the missing-components banner.
    useStore.getState().loadNetlist(UNSUPPORTED);
    const s = useStore.getState();
    expect(mergeProblem(s.unsupportedProblem, [])).toBe(MISSING_MESSAGE);
  });

  it('a second load replaces the message instead of merging it twice', () => {
    useStore.getState().loadNetlist(UNSUPPORTED);
    useStore.getState().loadNetlist('$ 1 0.000005 10 50 5 50 5e-11\n999 0 0 32 0 0 1\n998 0 0\n');
    const s = useStore.getState();
    expect(s.unsupportedProblem).toBe(
      '2 element type(s) (999, 998) are not implemented yet, so those components are ' +
        'missing from the drawing and the simulation.',
    );
  });
});

describe('a preserved line only flashes, it does not sit in the banner', () => {
  it('an h hint line takes the notice channel, leaving the banner empty', () => {
    useStore.getState().loadNetlist(INERT);
    const s = useStore.getState();
    expect(s.unsupportedNotice).toBe(INERT_MESSAGE);
    expect(s.problem).toBeNull();
    expect(s.unsupportedProblem).toBeNull();
    // The flash itself is the frame loop's, after the first build.
    expect(s.notice).toBeNull();
  });

  it('the engine warnings join the notice, never the banner', () => {
    useStore.getState().loadNetlist(INERT);
    const s = useStore.getState();
    expect(mergeProblem(s.unsupportedNotice, [FLOATING_WARNING])).toBe(
      `${INERT_MESSAGE} ${FLOATING_WARNING}`,
    );
    expect(mergeProblem(s.unsupportedProblem, [])).toBeNull();
  });

  it('a missing component and a preserved line are reported on separate channels', () => {
    useStore.getState().loadNetlist('$ 1 0.000005 10 50 5 50 5e-11\n999 0 0 32 0 0 1\nh 1 4 3\n');
    const s = useStore.getState();
    expect(s.problem).toBe(MISSING_MESSAGE);
    expect(s.unsupportedNotice).toBe(INERT_MESSAGE);
  });

  it('a clean circuit reports on neither channel', () => {
    useStore.getState().loadNetlist(CLEAN);
    const s = useStore.getState();
    expect(s.unsupportedProblem).toBeNull();
    expect(s.unsupportedNotice).toBeNull();
    expect(mergeProblem(s.unsupportedProblem, [])).toBeNull();
    expect(mergeProblem(s.unsupportedNotice, [])).toBeNull();
  });
});

describe('the clamp-on-load warning survives the frame-loop merge', () => {
  // A hand-edited 12-input AND gate (code 150): the engine supports at most 8
  // inputs, so the load clamps to 8 and the parse warns that a save would
  // rewrite the file (oversized-gates-load-policy, option 2). A clamp loses
  // data, so it belongs in the banner, not in the flash.
  const OVERSIZED_GATE = '$ 1 0.000005 10 50 5 50 5e-11\n150 0 0 96 0 0 12 0 5\n';
  const GATE_CLAMP_WARNING = 'AND gate with 12 inputs loaded as 8 inputs';

  it('an oversized gate loads clamped, with the warning in the banner', () => {
    useStore.getState().loadNetlist(OVERSIZED_GATE);
    const s = useStore.getState();
    expect(s.problem).toBe(GATE_CLAMP_WARNING);
    expect(s.unsupportedProblem).toBe(GATE_CLAMP_WARNING);
    expect(s.elements.find((e) => e.kind === 'andGate')?.params.inputCount).toBe(8);
  });

  it('the warning survives the first engine build', () => {
    // The frame loop merges the load-time message with the engine warnings
    // instead of overwriting it, so a warning-only circuit keeps the banner
    // after the first rebuild, the same guarantee as the unsupported message.
    useStore.getState().loadNetlist(OVERSIZED_GATE);
    const s = useStore.getState();
    expect(mergeProblem(s.unsupportedProblem, [])).toBe(GATE_CLAMP_WARNING);
  });

  it('an oversized chip width loads clamped, with the warning in the banner', () => {
    // The DAC shares the policy: a hand-edited 65-bit width clamps to the
    // engine's 30-bit ceiling and the parse warns about the loss.
    useStore.getState().loadNetlist('$ 1 0.000005 10 50 5 50 5e-11\n166 0 0 128 0 0 65\n');
    const s = useStore.getState();
    expect(s.problem).toBe('DAC with 65 bits loaded as 30 bits');
    expect(s.elements.find((e) => e.kind === 'dac')?.params.bits).toBe(30);
  });

  it('an in-range gate loads clean with no warning', () => {
    useStore.getState().loadNetlist('$ 1 0.000005 10 50 5 50 5e-11\n150 0 0 96 0 0 6 0 5\n');
    const s = useStore.getState();
    expect(s.problem).toBeNull();
    expect(s.unsupportedProblem).toBeNull();
    expect(s.elements.find((e) => e.kind === 'andGate')?.params.inputCount).toBe(6);
  });
});

describe('the unsupported message clears when the line goes', () => {
  it('New clears both channels', () => {
    useStore.getState().loadNetlist(UNSUPPORTED);
    useStore.getState().setNotice(INERT_MESSAGE);
    useStore.getState().newCircuit();
    const s = useStore.getState();
    expect(s.unsupportedProblem).toBeNull();
    expect(s.problem).toBeNull();
    expect(s.unsupportedNotice).toBeNull();
    expect(s.notice).toBeNull();
    // A later engine build must not resurrect either.
    expect(mergeProblem(s.unsupportedProblem, [])).toBeNull();
    expect(mergeProblem(s.unsupportedNotice, [])).toBeNull();
  });

  it('loading a clean circuit clears the unsupported message', () => {
    useStore.getState().loadNetlist(UNSUPPORTED);
    useStore.getState().loadNetlist(CLEAN);
    const s = useStore.getState();
    expect(s.unsupportedProblem).toBeNull();
    expect(s.problem).toBeNull();
    expect(mergeProblem(s.unsupportedProblem, [])).toBeNull();
  });

  it('loading a clean circuit clears a pending notice', () => {
    useStore.getState().loadNetlist(INERT);
    useStore.getState().setNotice(INERT_MESSAGE);
    useStore.getState().loadNetlist(CLEAN);
    const s = useStore.getState();
    expect(s.unsupportedNotice).toBeNull();
    expect(s.notice).toBeNull();
  });
});
