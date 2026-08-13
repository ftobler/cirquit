import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

describe('scope line display-field fidelity', () => {
  // Flags 266244 = showMax off (bit 4) + FLAG_PLOTS + FLAG_PERPLOTFLAGS, so
  // the scope has showMax off, an AC-coupled plot and an escaped label.
  const NETLIST = [
    '$ 1 0.000005 10 50 5 50 5e-11',
    'r 0 0 16 0 0 100',
    'o 0 64 0 266244 20 0.05 0 1 1 Ac\\sCoupled',
    '',
  ].join('\n');

  it('loads the display fields a scope line configures', () => {
    useStore.getState().loadNetlist(NETLIST);
    const scope = useStore.getState().scopes[0];
    expect(scope.showMax).toBe(false);
    expect(scope.label).toBe('Ac Coupled');
    expect(scope.plots[0].acCoupled).toBe(true);
  });

  it('saves an untouched loaded scope line byte-for-byte', () => {
    useStore.getState().loadNetlist(NETLIST);
    expect(useStore.getState().toNetlist()).toBe(NETLIST);
  });

  it('regenerates the line after a display edit and reloads the edit', () => {
    useStore.getState().loadNetlist(NETLIST);
    const id = useStore.getState().scopes[0].id;
    useStore.getState().setScopeFlags(id, { showMax: true, label: 'Renamed' });
    const saved = useStore.getState().toNetlist();
    // Bit 4 (showMax off) is gone, the coupling flag stays, and the label is
    // escaped as one token in the new-style line.
    expect(saved).toContain('o 0 64 0 266240 20 0.05 0 1 1 Renamed');
    useStore.getState().loadNetlist(saved);
    const scope = useStore.getState().scopes[0];
    expect(scope.showMax).toBe(true);
    expect(scope.label).toBe('Renamed');
    expect(scope.plots[0].acCoupled).toBe(true);
  });

  it('stacking writes the new position token back onto the line', () => {
    const TWO = [
      '$ 1 0.000005 10 50 5 50 5e-11',
      'r 0 0 16 0 0 100',
      'r 16 0 32 0 0 100',
      'o 0 64 0 4099 20 0.05 0 1',
      'o 1 64 0 4099 20 0.05 0 1',
      '',
    ].join('\n');
    useStore.getState().loadNetlist(TWO);
    const [, second] = useStore.getState().scopes;
    useStore.getState().unstackScope(second.id);
    const lines = useStore.getState().toNetlist().split('\n');
    // The untouched first scope keeps its raw line; the unstacked one is
    // regenerated with the new position token.
    expect(lines[3]).toBe('o 0 64 0 4099 20 0.05 0 1');
    expect(lines[4]).toBe('o 1 64 0 4099 20 0.05 1 1');
  });

  it('a UI-created scope with label, AC coupling and manScale saves a parseable line', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scope = useStore.getState().scopes[0];
    useStore.getState().setScopeFlags(scope.id, { label: 'Power Out' });
    useStore.getState().setPlotCoupling(scope.id, scope.plots[0].id, true);
    useStore.getState().setPlotManScale(scope.plots[1].id, 2);
    const netlist = useStore.getState().toNetlist();
    // FLAG_PERPLOTFLAGS (1<<18) and FLAG_PERPLOT_MAN_SCALE (1<<19) both ride
    // the flag word, with one per-plot token group per plot.
    expect(netlist).toContain('o 0 64 0 790531 20 0.05 0 2 1 1 0 0 0 3 2 0 Power\\sOut');
    useStore.getState().loadNetlist(netlist);
    const reloaded = useStore.getState().scopes[0];
    expect(reloaded.label).toBe('Power Out');
    expect(reloaded.plots[0].acCoupled).toBe(true);
    expect(reloaded.plots[1].manScale).toBe(2);
    expect(reloaded.plots[0].manScale).toBe(1);
  });
});
