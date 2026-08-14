import { beforeEach, describe, expect, it } from 'vitest';
import { mergeProblem, useStore } from './store';
import { fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

// `999` is the corpus's canonical unknown element code: this build does not
// construct it, so the parse reports it unsupported and the load sets the
// missing-components banner. A future upstream element code arrives the same
// way, through the same `describeUnsupported` path.
const UNSUPPORTED = '$ 1 0.000005 10 50 5 50 5e-11\n999 0 0 32 0 0 1\n';
const MISSING_MESSAGE = '1 other line type(s) (999) were preserved but not interpreted.';
// The engine's floating-node warning wording (circuit.rs:871-873).
const FLOATING_WARNING =
  '1 floating node(s) have no path to ground; they were pinned with a 100 M\u2126 resistance.';
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

  it('an engine warning and the unsupported message appear merged', () => {
    useStore.getState().loadNetlist(UNSUPPORTED);
    const s = useStore.getState();
    expect(mergeProblem(s.unsupportedProblem, [FLOATING_WARNING])).toBe(
      `${MISSING_MESSAGE} ${FLOATING_WARNING}`,
    );
  });

  it('engine warnings alone show, and a clean circuit shows nothing', () => {
    useStore.getState().loadNetlist(CLEAN);
    const s = useStore.getState();
    expect(s.unsupportedProblem).toBeNull();
    expect(mergeProblem(s.unsupportedProblem, [FLOATING_WARNING])).toBe(FLOATING_WARNING);
    expect(mergeProblem(s.unsupportedProblem, [])).toBeNull();
  });

  it('a second load replaces the message instead of merging it twice', () => {
    useStore.getState().loadNetlist(UNSUPPORTED);
    useStore.getState().loadNetlist(
      '$ 1 0.000005 10 50 5 50 5e-11\n999 0 0 32 0 0 1\n% 1 2\n',
    );
    const s = useStore.getState();
    expect(s.unsupportedProblem).toBe(
      '2 other line type(s) (999, %) were preserved but not interpreted.',
    );
  });
});

describe('the clamp-on-load warning survives the frame-loop merge', () => {
  // A hand-edited 12-input AND gate (code 150): the engine supports at most 8
  // inputs, so the load clamps to 8 and the parse warns that a save would
  // rewrite the file (oversized-gates-load-policy, option 2).
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
    expect(mergeProblem(s.unsupportedProblem, [FLOATING_WARNING])).toBe(
      `${GATE_CLAMP_WARNING} ${FLOATING_WARNING}`,
    );
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
  it('New clears the unsupported message and the banner', () => {
    useStore.getState().loadNetlist(UNSUPPORTED);
    useStore.getState().newCircuit();
    const s = useStore.getState();
    expect(s.unsupportedProblem).toBeNull();
    expect(s.problem).toBeNull();
    // A later engine build must not resurrect it.
    expect(mergeProblem(s.unsupportedProblem, [])).toBeNull();
  });

  it('loading a clean circuit clears the unsupported message', () => {
    useStore.getState().loadNetlist(UNSUPPORTED);
    useStore.getState().loadNetlist(CLEAN);
    const s = useStore.getState();
    expect(s.unsupportedProblem).toBeNull();
    expect(s.problem).toBeNull();
    expect(mergeProblem(s.unsupportedProblem, [])).toBeNull();
  });
});
