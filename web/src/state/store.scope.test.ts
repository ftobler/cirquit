import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { addResistor, fresh } from './store.test-helpers';
import { SCOPE_DEFAULTS_STORAGE_KEY } from './scopeDefaults';
import type { StorageLike } from './appPrefs';

beforeEach(() => useStore.setState(fresh()));

/** A plain-object storage standing in for the DOM localStorage, injected via
 *  the global so makeScope's loadScopeDefaults reads it. */
const injectStorage = (blob: string | null): StorageLike & { restore: () => void } => {
  const map = new Map<string, string>();
  if (blob !== null) map.set(SCOPE_DEFAULTS_STORAGE_KEY, blob);
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  } as StorageLike;
  const prior = (globalThis as { localStorage?: StorageLike }).localStorage;
  (globalThis as { localStorage?: StorageLike }).localStorage = storage;
  return {
    ...storage,
    restore: () => {
      if (prior === undefined) delete (globalThis as { localStorage?: StorageLike }).localStorage;
      else (globalThis as { localStorage?: StorageLike }).localStorage = prior;
    },
  };
};


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

  it('a per-trace edit on a combined scope lands on that trace alone', () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().addScope(a, 'voltage');
    useStore.getState().addScope(b, 'voltage');
    const [sa, sb] = useStore.getState().scopes;
    useStore.getState().combineScopes(sa.id, sb.id);
    const combined = useStore.getState().scopes[0];
    // Each scope carries a voltage trace and its current companion.
    expect(combined.plots).toHaveLength(4);
    const pa = combined.plots.find((p) => p.value === 'voltage')!;
    const pb = combined.plots.find((p) => p.value === 'current')!;

    // The channel selector edits one trace at a time: position, max value and
    // coupling must each change only the targeted plot's per-plot state.
    useStore.getState().setPlotManPosition(pa.id, 120);
    useStore.getState().setPlotManScale(pb.id, 4);
    useStore.getState().setPlotCoupling(combined.id, pa.id, true);
    const after = useStore.getState().scopes[0];
    const qa = after.plots.find((p) => p.id === pa.id)!;
    const qb = after.plots.find((p) => p.id === pb.id)!;
    expect(qa.manVPosition).toBe(120);
    expect(qb.manVPosition).toBe(0);
    expect(qb.manScale).toBe(4);
    expect(qa.acCoupled).toBe(true);
    expect(qb.acCoupled).toBe(false);
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

  it('togglePlot adds and removes a power plot, the Show Power box path', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scope = useStore.getState().scopes[0];
    expect(scope.plots.some((p) => p.value === 'power')).toBe(false);
    useStore.getState().togglePlot(scope.id, 'power');
    const added = useStore.getState().scopes[0];
    expect(added.plots.some((p) => p.value === 'power' && p.elementId === r)).toBe(true);
    // Unchecking removes the power plot but never empties the panel.
    useStore.getState().togglePlot(scope.id, 'power');
    expect(useStore.getState().scopes[0].plots.some((p) => p.value === 'power')).toBe(false);
    expect(useStore.getState().scopes[0].plots.length).toBeGreaterThan(0);
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

describe('stored scope defaults seed a new scope', () => {
  it('loadDefaults applies the stored flags, speed and trigger level', () => {
    const storage = injectStorage(
      JSON.stringify({ flags: 8392706, speed: 32, level: 2.5 }),  // 1<<23 + showV + FLAG_PLOTS
    );
    try {
      const r = addResistor();
      useStore.getState().addScope(r, 'voltage');
      const scope = useStore.getState().scopes[0];
      expect(scope.showPhaseAngle).toBe(true);
      expect(scope.speed).toBe(32);
      expect(scope.trigger.level).toBe(2.5);
    } finally {
      storage.restore();
    }
  });

  it('a corrupt blob leaves the scope on its plain defaults', () => {
    const storage = injectStorage('{not json');
    try {
      const r = addResistor();
      useStore.getState().addScope(r, 'voltage');
      const scope = useStore.getState().scopes[0];
      expect(scope.showPhaseAngle).toBe(false);
      expect(scope.speed).toBe(64);
      expect(scope.trigger.level).toBe(0);
    } finally {
      storage.restore();
    }
  });

  it('a loaded file keeps its own speed token over the stored default', () => {
    const storage = injectStorage(JSON.stringify({ flags: 4098, speed: 32, level: 0 }));
    try {
      const NETLIST = [
        '$ 1 0.000005 10 50 5 50 5e-11',
        'r 0 0 16 0 0 100',
        'o 0 256 0 4099 20 0.05 0 1',
        '',
      ].join('\n');
      useStore.getState().loadNetlist(NETLIST);
      expect(useStore.getState().scopes[0].speed).toBe(256);
    } finally {
      storage.restore();
    }
  });
});

describe('reset a scope to the defaults', () => {
  it('puts the display fields, speed, trigger and plot state back', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scope = useStore.getState().scopes[0];
    useStore.getState().setScopeFlags(scope.id, {
      showRMS: true,
      showMax: false,
      fftPlot: true,
      label: 'Renamed',
    });
    useStore.getState().setScopeSpeed(scope.id, 256);
    useStore.getState().setScopeTrigger(scope.id, { mode: 'auto', level: 3 });
    useStore.getState().setPlotManScale(scope.plots[0].id, 12);
    useStore.getState().setPlotManPosition(scope.plots[0].id, -80);

    useStore.getState().resetScopeToDefaults(scope.id);

    const reset = useStore.getState().scopes[0];
    expect(reset.id).toBe(scope.id);
    expect(reset.showRMS).toBe(false);
    expect(reset.showMax).toBe(true);
    expect(reset.fftPlot).toBe(false);
    expect(reset.label).toBe('');
    expect(reset.speed).toBe(64);
    expect(reset.trigger).toEqual({ mode: 'freeRun', edge: 'rising', level: 0 });
    // The traces survive: a reset changes how the panel draws, not what it
    // watches.
    expect(reset.plots.map((p) => p.id)).toEqual(scope.plots.map((p) => p.id));
    expect(reset.plots[0].manScale).toBeNull();
    expect(reset.plots[0].manVPosition).toBe(0);
  });

  it('a power plot returns to the bottom of the manual screen, not to zero', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'power');
    const scope = useStore.getState().scopes[0];
    expect(scope.plots[0].manVPosition).toBe(-100);
    useStore.getState().setPlotManPosition(scope.plots[0].id, 40);

    useStore.getState().resetScopeToDefaults(scope.id);

    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(-100);
  });

  it('resets to the stored default, the same one Save as Default writes', () => {
    const storage = injectStorage(JSON.stringify({ flags: 8392706, speed: 32, level: 2.5 }));
    try {
      const r = addResistor();
      useStore.getState().addScope(r, 'voltage');
      const scope = useStore.getState().scopes[0];
      useStore.getState().setScopeFlags(scope.id, { showPhaseAngle: false });
      useStore.getState().setScopeSpeed(scope.id, 256);

      useStore.getState().resetScopeToDefaults(scope.id);

      const reset = useStore.getState().scopes[0];
      expect(reset.showPhaseAngle).toBe(true);
      expect(reset.speed).toBe(32);
      expect(reset.trigger.level).toBe(2.5);
    } finally {
      storage.restore();
    }
  });

  it('is one undo entry', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scope = useStore.getState().scopes[0];
    useStore.getState().setScopeFlags(scope.id, { showRMS: true, label: 'Renamed' });

    useStore.getState().resetScopeToDefaults(scope.id);
    useStore.getState().undo();

    const back = useStore.getState().scopes[0];
    expect(back.showRMS).toBe(true);
    expect(back.label).toBe('Renamed');
  });
});
