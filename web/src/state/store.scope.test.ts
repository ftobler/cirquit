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

  it('a UI-created manual-mode scope with label, AC coupling and manScale saves a parseable line', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scope = useStore.getState().scopes[0];
    useStore.getState().setScopeFlags(scope.id, { label: 'Power Out', manualScale: true });
    useStore.getState().setPlotCoupling(scope.id, scope.plots[0].id, true);
    useStore.getState().setPlotManScale(scope.plots[1].id, 2);
    const netlist = useStore.getState().toNetlist();
    // FLAG_PERPLOTFLAGS (1<<18), FLAG_PERPLOT_MAN_SCALE (1<<19) and
    // FLAG_DIVISIONS (1<<21) all ride the flag word in manual mode, with one
    // per-plot token group per plot and the divisions token after the count.
    expect(netlist).toContain('o 0 64 0 2887699 20 0.05 0 2 8 1 1 0 0 0 3 2 0 Power\\sOut');
    useStore.getState().loadNetlist(netlist);
    const reloaded = useStore.getState().scopes[0];
    expect(reloaded.label).toBe('Power Out');
    expect(reloaded.manualScale).toBe(true);
    expect(reloaded.plots[0].acCoupled).toBe(true);
    expect(reloaded.plots[1].manScale).toBe(2);
    expect(reloaded.plots[0].manScale).toBe(1);
  });

  it('the manDivisions field persists through the line and reloads', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scope = useStore.getState().scopes[0];
    useStore.getState().setScopeFlags(scope.id, { manualScale: true, manDivisions: 6 });
    const netlist = useStore.getState().toNetlist();
    // Manual mode writes FLAG_DIVISIONS plus the divisions token after the
    // plot count, and a man-scale pair per plot.
    expect(netlist).toContain('o 0 64 0 2625555 20 0.05 0 2 6 1 0 0 3 1 0');
    useStore.getState().loadNetlist(netlist);
    expect(useStore.getState().scopes[0].manDivisions).toBe(6);
  });
});

describe('scope plot visibility (showV/showI)', () => {
  it('setScopeShowValue hides and shows the matching plots without a reload', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scope = useStore.getState().scopes[0];
    const before = useStore.getState().revision;
    useStore.getState().setScopeShowValue(scope.id, 'voltage', false);
    const s = useStore.getState();
    expect(s.scopes[0].showV).toBe(false);
    // A visibility flag is display-only, so the simulation must not rewind.
    expect(s.revision).toBe(before);
    useStore.getState().setScopeShowValue(scope.id, 'voltage', true);
    expect(useStore.getState().scopes[0].showV).toBe(true);
    expect(useStore.getState().revision).toBe(before);
  });

  it('turning a value on with no plot of it present adds one and reloads', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scope = useStore.getState().scopes[0];
    // Drop the current companion, then re-show it: the plot comes back.
    useStore.getState().togglePlot(scope.id, 'current');
    expect(useStore.getState().scopes[0].plots).toHaveLength(1);
    const before = useStore.getState().revision;
    useStore.getState().setScopeShowValue(scope.id, 'current', true);
    const s = useStore.getState();
    expect(s.scopes[0].showI).toBe(true);
    expect(s.scopes[0].plots).toHaveLength(2);
    expect(s.scopes[0].plots[1]).toMatchObject({ value: 'current', elementId: r });
    // A new plot changes the engine spec, so it forces a reload.
    expect(s.revision).toBe(before + 1);
  });

  it('a loaded line with showI clear keeps the current plot hidden state', () => {
    // showV only (flags 2): the line carries a current companion but the file
    // says it is not shown, so the port must remember showI is off.
    const NETLIST = [
      '$ 1 0.000005 10 50 5 50 5e-11',
      'r 0 0 16 0 0 100',
      'o 0 64 0 4098 20 0.05 0 2 0 3',
      '',
    ].join('\n');
    useStore.getState().loadNetlist(NETLIST);
    const scope = useStore.getState().scopes[0];
    expect(scope.showV).toBe(true);
    expect(scope.showI).toBe(false);
    // Untouched, the line still saves byte-for-byte.
    expect(useStore.getState().toNetlist()).toBe(NETLIST);
  });
});

describe('charge scope value', () => {
  it('addScope charge emits the C-scale token and reloads as charge', () => {
    const id = useStore.getState().addElement({
      kind: 'capacitor',
      x1: 0,
      y1: 0,
      x2: 16,
      y2: 0,
      flags: 0,
      params: { capacitance: 1e-6, initialVoltage: 0.001 },
    });
    useStore.getState().addScope(id, 'charge');
    const line = useStore
      .getState()
      .toNetlist()
      .split('\n')
      .find((l) => l.startsWith('o '));
    // Token 8 with the C-scale token (units > A), exactly like the power line.
    expect(line).toBe('o 0 64 8 4099 20 0.05 0 1 20');
    useStore.getState().loadNetlist(useStore.getState().toNetlist());
    const reloaded = useStore.getState().scopes[0];
    expect(reloaded.plots[0].value).toBe('charge');
  });

  it('a charge plot starts at the bottom of the manual-mode screen', () => {
    const id = useStore.getState().addElement({
      kind: 'capacitor',
      x1: 0,
      y1: 0,
      x2: 16,
      y2: 0,
      flags: 0,
      params: { capacitance: 1e-6, initialVoltage: 0.001 },
    });
    useStore.getState().addScope(id, 'charge');
    // Upstream's ScopePlot constructor parks W/C plots at manVPosition -100
    // (ScopePlot.java:62-66).
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(-100);
  });

  it('setPlotManPosition clamps to the +-V_POSITION_STEPS span', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const plot = useStore.getState().scopes[0].plots[0];
    useStore.getState().setPlotManPosition(plot.id, 500);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(200);
    useStore.getState().setPlotManPosition(plot.id, -500);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(-200);
  });
});
