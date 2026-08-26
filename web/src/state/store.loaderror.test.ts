/** I-M1 regression: a malformed document must reach the user as a problem
 *  banner over the circuit still on screen, never as a thrown escape from a
 *  click handler or as the engine-fatal startup page. The engine is fine; the
 *  circuit is not. */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildReport } from '../ui/canvas/useFrameLoop';
import { useStore } from './store';
import { fresh } from './store.test-helpers';

const GOOD = '$ 1 0.000005 10 50 5 5 1e-9\nr 0 0 160 0 0 1000\n';
// isXml matches (the first line opens `<cir `), and the parser's nesting check
// throws on the unclosed element, the truncated-document case.
const BAD_XML = '<cir name="broken">\n<r x="1"/>\n';

beforeEach(() => useStore.setState(fresh()));

describe('loadNetlist error routing', () => {
  it('a malformed XML document lands in the problem banner and keeps the old circuit', () => {
    useStore.getState().loadNetlist(GOOD);
    const kept = useStore.getState().elements;
    expect(kept).toHaveLength(1);

    const failure = useStore.getState().loadNetlist(BAD_XML);

    expect(failure).not.toBeNull();
    const s = useStore.getState();
    expect(s.problem).toBe(failure);
    // The refusal must not seed the frame-loop channel: it describes no open
    // document, so seeding it would resurrect the banner over unrelated
    // rebuilds of the healthy circuit still on screen.
    expect(s.unsupportedProblem).toBeNull();
    // The old circuit stays on screen untouched, down to element identity.
    expect(s.elements).toBe(kept);
    expect(s.undoStack).toHaveLength(0);
  });

  it('reports the conversion failure text, not an opaque refusal', () => {
    const failure = useStore.getState().loadNetlist(BAD_XML);
    expect(failure).toContain('xml');
  });

  it('a refused load seeds no sticky channel, so dismissal sticks', () => {
    useStore.getState().loadNetlist(GOOD);
    useStore.getState().loadNetlist(BAD_XML);
    // Dismissing clears `problem` only; that must be the end of the refusal,
    // or every later rebuild merges it back over a document it does not
    // describe.
    useStore.getState().setProblem(null);
    expect(useStore.getState().problem).toBeNull();
    const report = buildReport(null, [], useStore.getState().unsupportedProblem);
    expect(report.problem).toBeNull();
    expect(report.notice).toBeNull();
  });

  it('a successful load reports null and clears any standing banner', () => {
    useStore.getState().setProblem('stale banner');
    expect(useStore.getState().loadNetlist(GOOD)).toBeNull();
    expect(useStore.getState().problem).toBeNull();
    expect(useStore.getState().unsupportedProblem).toBeNull();
  });
});
