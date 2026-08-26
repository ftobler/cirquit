import { beforeEach, describe, expect, it } from 'vitest';
import {
  anyPlotOverrides,
  effectiveMeasurements,
  plotOverridesScope,
} from '../engine/scopeModel';
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

describe('per-element value plots on the o line', () => {
  // early.txt's arrangement: two plots on one transistor, Vce first and Ic
  // second, under plotXY (bit 64) with per-plot flag tokens riding
  // FLAG_PERPLOTFLAGS.
  const TRANSISTOR = [
    '$ 1 0.000005 10 50 5 50 5e-11',
    't 0 0 16 0 0 1 0 0 100 default',
    'o 0 64 6 266306 4e-7 1e-17 0 2 0 0 0 2 no\\sEarly\\seffect',
    '',
  ].join('\n');

  it('maps both plots of a Vce-vs-Ic line to engine-sampled values', () => {
    useStore.getState().loadNetlist(TRANSISTOR);
    const scope = useStore.getState().scopes[0];
    expect(scope.plots.map((p) => p.value)).toEqual(['vce', 'ic']);
    expect(scope.plotXY).toBe(true);
    expect(scope.plotX).toBe(0);
    expect(scope.plotY).toBe(1);
  });

  it('saves an untouched Vce-vs-Ic scope byte-for-byte and keeps the tokens on edit', () => {
    useStore.getState().loadNetlist(TRANSISTOR);
    expect(useStore.getState().toNetlist()).toBe(TRANSISTOR);

    const id = useStore.getState().scopes[0].id;
    useStore.getState().setScopeFlags(id, { label: 'Renamed' });
    const saved = useStore.getState().toNetlist();
    // The regenerated line re-encodes VAL_VCE as 6 and VAL_IC as 2; the
    // per-plot flag words drop out with their bit because neither plot is
    // coupled (the same normalisation every uncoupled loaded line takes).
    expect(saved).toContain('o 0 64 6 4290 4e-7 1e-17 0 2 0 2 Renamed');
    useStore.getState().loadNetlist(saved);
    expect(useStore.getState().scopes[0].plots.map((p) => p.value)).toEqual(['vce', 'ic']);
  });

  it('the X-Y axis selection is session state that never rewrites the line', () => {
    // Upstream's text format carries no plotX/plotY (only its XML format
    // does), so swapping the axes here must not dirty the untouched raw line,
    // exactly like the trail persistence before it.
    useStore.getState().loadNetlist(TRANSISTOR);
    const id = useStore.getState().scopes[0].id;
    useStore.getState().setScopeFlags(id, { plotX: 1, plotY: 0 });
    const scope = useStore.getState().scopes[0];
    expect(scope.plotX).toBe(1);
    expect(scope.plotY).toBe(0);
    expect(useStore.getState().toNetlist()).toBe(TRANSISTOR);
  });

  it('a lamp resistance plot round-trips through its VAL_R token', () => {
    const NETLIST = [
      '$ 1 0.000005 10 50 5 50 5e-11',
      '181 0 0 16 0 0 293 100 120 0.4 0.4',
      'o 0 64 2 4099 160 1.6 0 1 160',
      '',
    ].join('\n');
    useStore.getState().loadNetlist(NETLIST);
    const scope = useStore.getState().scopes[0];
    expect(scope.plots[0].value).toBe('resistance');
    // A resistance plot sits at the bottom of the manual screen like power
    // and charge (ScopePlot.java:62-66).
    expect(scope.plots[0].manVPosition).toBe(-100);
    expect(useStore.getState().toNetlist()).toBe(NETLIST);
  });
});

describe('the Show Vce vs Ic action', () => {
  const addTransistorScope = () => {
    // `addElement` hands back the new id directly.
    const elementId = useStore.getState().addElement({
      kind: 'transistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { pnp: 1 },
    });
    useStore.getState().addScope(elementId, 'voltage');
    return { elementId, scopeId: useStore.getState().scopes[0].id };
  };

  it('seeds the pair, turns X-Y on and resets the axes', () => {
    const { scopeId } = addTransistorScope();
    // Park the axes and a modulator somewhere custom first: upstream's
    // command resets them like its plotxy branch does (Scope.java:1329-1333).
    useStore.getState().setScopeFlags(scopeId, { plotX: 1, plotY: 1, plotColorR: 0 });
    useStore.getState().setScopeVceIc(scopeId);
    const after = useStore.getState().scopes[0];
    expect(after.plotXY).toBe(true);
    expect(after.plotX).toBe(0);
    expect(after.plotY).toBe(1);
    expect(after.plotBrightness).toBe(-1);
    expect(after.plotColorR).toBe(-1);
    expect(after.plots.map((p) => p.value)).toEqual(['vce', 'ic']);
    expect(after.plots.map((p) => p.elementId)).toEqual([
      after.plots[0].elementId,
      after.plots[0].elementId,
    ]);
  });

  it('pushes one undo entry and treats a repeat click as a no-op', () => {
    const { scopeId } = addTransistorScope();
    const depth = useStore.getState().undoStack.length;
    useStore.getState().setScopeVceIc(scopeId);
    expect(useStore.getState().undoStack.length).toBe(depth + 1);
    useStore.getState().setScopeVceIc(scopeId);
    expect(useStore.getState().undoStack.length).toBe(depth + 1);
  });

  it('unchecking leaves the pair as stacked traces and the save keeps both tokens', () => {
    const { scopeId } = addTransistorScope();
    useStore.getState().setScopeVceIc(scopeId);
    // The dialog's uncheck path is the display-only flag flip.
    useStore.getState().setScopeFlags(scopeId, { plotXY: false });
    const off = useStore.getState().scopes[0];
    expect(off.plotXY).toBe(false);
    expect(off.plots.map((p) => p.value)).toEqual(['vce', 'ic']);

    useStore.getState().loadNetlist(useStore.getState().toNetlist());
    expect(useStore.getState().scopes[0].plots.map((p) => p.value)).toEqual(['vce', 'ic']);
  });
});

describe('per-channel measurement flags', () => {
  /** A combined scope over two resistors: four plots, A's V+I then B's. */
  const combinedScope = () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().addScope(a, 'voltage');
    useStore.getState().addScope(b, 'voltage');
    const [sa, sb] = useStore.getState().scopes;
    useStore.getState().combineScopes(sa.id, sb.id);
    return useStore.getState().scopes[0];
  };

  it('setPlotMeasurementFlag changes one trace and not its stacked sibling', () => {
    const scope = combinedScope();
    const pa = scope.plots[0];
    const pb = scope.plots[2];
    const before = useStore.getState().revision;
    useStore.getState().setPlotMeasurementFlag(pa.id, 'showFreq', true);
    const after = useStore.getState().scopes[0];
    const qa = after.plots.find((p) => p.id === pa.id)!;
    const qb = after.plots.find((p) => p.id === pb.id)!;
    // The mask is seeded from the scope word, so only Freq moves and the
    // other readouts keep the inherited values.
    expect(qa.measurements!.showFreq).toBe(true);
    expect(qa.measurements!.showMax).toBe(after.showMax);
    expect(qb.measurements).toBeNull();
    // A readout flag is display-only, like setScopeFlags.
    expect(useStore.getState().revision).toBe(before);
  });

  it('a repeat click changes nothing and pushes no undo entry', () => {
    const scope = combinedScope();
    const pa = scope.plots[0];
    useStore.getState().setPlotMeasurementFlag(pa.id, 'showFreq', true);
    const depth = useStore.getState().undoStack.length;
    useStore.getState().setPlotMeasurementFlag(pa.id, 'showFreq', true);
    expect(useStore.getState().undoStack.length).toBe(depth);
  });

  it('the badge condition tracks masks that differ from the scope word only', () => {
    const scope = combinedScope();
    const pa = scope.plots[0];
    expect(plotOverridesScope(scope, pa)).toBe(false);
    useStore.getState().setPlotMeasurementFlag(pa.id, 'showFreq', true);
    let after = useStore.getState().scopes[0];
    expect(plotOverridesScope(after, after.plots[0])).toBe(true);
    // Flipping the bit back leaves an override that equals the scope word
    // everywhere: it draws exactly like inheriting, so no badge.
    useStore.getState().setPlotMeasurementFlag(pa.id, 'showFreq', false);
    after = useStore.getState().scopes[0];
    expect(after.plots[0].measurements).not.toBeNull();
    expect(plotOverridesScope(after, after.plots[0])).toBe(false);
  });

  it('the all-traces path writes the scope word every plot inherits', () => {
    const scope = combinedScope();
    // The dialog's "Apply to all traces" checkbox is this call: no plot grows
    // a mask, every trace follows the scope word.
    useStore.getState().setScopeFlags(scope.id, { showFreq: true });
    const after = useStore.getState().scopes[0];
    expect(after.plots.every((p) => p.measurements === null)).toBe(true);
    for (const p of after.plots) {
      expect(effectiveMeasurements(after, p).showFreq).toBe(true);
    }
    // A stale per-trace override does not follow the scope word on its own;
    // switching the toggle back on clears it first.
    useStore.getState().setPlotMeasurementFlag(after.plots[0].id, 'showFreq', false);
    const mixed = useStore.getState().scopes[0];
    expect(effectiveMeasurements(mixed, mixed.plots[0]).showFreq).toBe(false);
    useStore.getState().clearPlotMeasurementOverrides(scope.id);
    const cleared = useStore.getState().scopes[0];
    expect(effectiveMeasurements(cleared, cleared.plots[0]).showFreq).toBe(true);
  });

  it('switching back to all traces clears the overrides so they cannot hide', () => {
    const scope = combinedScope();
    useStore.getState().setPlotMeasurementFlag(scope.plots[0].id, 'showFreq', true);
    useStore.getState().clearPlotMeasurementOverrides(scope.id);
    expect(useStore.getState().scopes[0].plots.every((p) => p.measurements === null)).toBe(true);
    // Clearing with nothing overridden is a no-op: no undo entry.
    const depth = useStore.getState().undoStack.length;
    useStore.getState().clearPlotMeasurementOverrides(scope.id);
    expect(useStore.getState().undoStack.length).toBe(depth);
  });

  it('one undo restores both traces after their overrides were cleared', () => {
    const scope = combinedScope();
    const pa = scope.plots[0];
    const pb = scope.plots[2];
    useStore.getState().setPlotMeasurementFlag(pa.id, 'showFreq', true);
    useStore.getState().setPlotMeasurementFlag(pb.id, 'showMin', true);
    useStore.getState().clearPlotMeasurementOverrides(scope.id);
    useStore.getState().undo();
    // The clear is one undo entry: both overrides come back together.
    const restored = useStore.getState().scopes[0];
    expect(restored.plots.find((p) => p.id === pa.id)!.measurements!.showFreq).toBe(true);
    expect(restored.plots.find((p) => p.id === pb.id)!.measurements!.showMin).toBe(true);
    // Each setter committed its own entry, so undoing further peels them off
    // one at a time back to the untouched baseline.
    useStore.getState().undo();
    const half = useStore.getState().scopes[0];
    expect(half.plots.find((p) => p.id === pb.id)!.measurements).toBeNull();
    useStore.getState().undo();
    const baseline = useStore.getState().scopes[0];
    expect(baseline.plots.every((p) => p.measurements === null)).toBe(true);
  });

  it('a per-trace measurement rides the saved o line and reloads', () => {
    addResistor();
    useStore.getState().addScope(useStore.getState().elements[0].id, 'voltage');
    const scope = useStore.getState().scopes[0];
    useStore.getState().setPlotMeasurementFlag(scope.plots[0].id, 'showFreq', true);
    const saved = useStore.getState().toNetlist();
    // showI+showV + FLAG_PLOTS + FLAG_PERPLOTFLAGS in the word. Plot 0's
    // token is seeded from the scope word, so it carries the default
    // showMax (bit 2) plus Freq (bit 5), and the mask-present sentinel rides
    // at bit 10: 1024 + 4 + 32 = 1060 = hex 424; plot 1 stays '0'.
    expect(saved).toContain('o 0 64 0 266243 20 0.05 0 2 424 0 0 3');
    useStore.getState().loadNetlist(saved);
    const reloaded = useStore.getState().scopes[0];
    expect(reloaded.plots[0].measurements!.showFreq).toBe(true);
    expect(reloaded.plots[1].measurements).toBeNull();
    expect(useStore.getState().toNetlist()).toBe(saved);
  });

  it('one click, unchecking Max on one channel under Apply-to-all off, survives a round trip', () => {
    // The regression the sentinel fixes: Max is the only default-on readout,
    // so that single click seeds the mask from the scope word and flips it
    // all-off. Before bit 10 existed the saved token was '0' and reload
    // resurrected every inherited readout.
    addResistor();
    useStore.getState().addScope(useStore.getState().elements[0].id, 'voltage');
    const scope = useStore.getState().scopes[0];
    useStore.getState().setPlotMeasurementFlag(scope.plots[0].id, 'showMax', false);
    const mask = useStore.getState().scopes[0].plots[0].measurements!;
    expect(mask.showMax).toBe(false);
    expect(
      Object.values(mask).every((v) => v === false),
    ).toBe(true);
    const saved = useStore.getState().toNetlist();
    // The token is the bare sentinel: hex '400'.
    expect(saved).toContain('o 0 64 0 266243 20 0.05 0 2 400 0 0 3');
    useStore.getState().loadNetlist(saved);
    const reloaded = useStore.getState().scopes[0];
    expect(reloaded.plots[0].measurements).not.toBeNull();
    expect(Object.values(reloaded.plots[0].measurements!).every((v) => v === false)).toBe(true);
    expect(useStore.getState().toNetlist()).toBe(saved);
  });

  it('the dialog reopens targeting the selected channel while overrides exist', () => {
    // ScopeProperties seeds applyToAll from anyPlotOverrides, so a reopened
    // dialog starts with the toggle off and keeps editing the picked channel.
    combinedScope();
    const scope = useStore.getState().scopes[0];
    expect(anyPlotOverrides(scope)).toBe(false);
    useStore.getState().setPlotMeasurementFlag(scope.plots[0].id, 'showFreq', true);
    expect(anyPlotOverrides(useStore.getState().scopes[0])).toBe(true);
    useStore.getState().clearPlotMeasurementOverrides(scope.id);
    expect(anyPlotOverrides(useStore.getState().scopes[0])).toBe(false);
  });

  it('clearing the last override puts an untouched loaded line back to byte-identical', () => {
    const NETLIST = [
      '$ 1 0.000005 10 50 5 50 5e-11',
      'r 0 0 16 0 0 100',
      'o 0 64 0 4099 20 0.05 0 1',
      '',
    ].join('\n');
    useStore.getState().loadNetlist(NETLIST);
    const scope = useStore.getState().scopes[0];
    useStore.getState().setPlotMeasurementFlag(scope.plots[0].id, 'showFreq', true);
    expect(useStore.getState().toNetlist()).not.toBe(NETLIST);
    useStore.getState().clearPlotMeasurementOverrides(scope.id);
    expect(useStore.getState().toNetlist()).toBe(NETLIST);
  });

  it('reset to default drops the per-trace overrides too', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scope = useStore.getState().scopes[0];
    useStore.getState().setPlotMeasurementFlag(scope.plots[0].id, 'showFreq', true);
    useStore.getState().resetScopeToDefaults(scope.id);
    expect(
      useStore.getState().scopes[0].plots.every((p) => p.measurements === null),
    ).toBe(true);
  });
});

describe('uninterpretable plot tokens survive an edit-save cycle', () => {
  // The second `r` has an unreadable coordinate token, so it degrades to a
  // preserved line while still taking file slot 1: a plot naming slot 2
  // resolves to nothing, upstream's unattached-trace case.
  const UNRESOLVED_NE = [
    '$ 1 0.000005 10 50 5 50 5e-11',
    'r 0 0 16 0 0 100',
    'r 16 0 zz 0 0 100',
    'o 0 64 0 4098 20 0.05 0 2 2 3 Mx',
    '',
  ].join('\n');

  it('an ne that never resolved is written back, not replaced with -1', () => {
    useStore.getState().loadNetlist(UNRESOLVED_NE);
    const scope = useStore.getState().scopes[0];
    expect(scope.plots[1].elementId).toBeNull();
    // Untouched, the raw line still saves verbatim.
    expect(useStore.getState().toNetlist()).toBe(UNRESOLVED_NE);

    useStore.getState().setScopeFlags(scope.id, { label: 'Ed' });
    const saved = useStore.getState().toNetlist();
    expect(saved).toContain('o 0 64 0 4098 20 0.05 0 2 2 3 Ed');

    // And the regenerated line loads back to the same shape, so the cycle has
    // a fixed point.
    useStore.getState().loadNetlist(saved);
    const again = useStore.getState().scopes[0];
    expect(again.plots[1].elementId).toBeNull();
    expect(useStore.getState().toNetlist()).toBe(saved);
  });

  it('a val token with no engine meaning is written back, not replaced with 0', () => {
    // Token 9 sits above the transistor's VAL_ table, so plot 1 decodes null;
    // the file's token must survive an edit instead of becoming voltage (0).
    const NETLIST = [
      '$ 1 0.000005 10 50 5 50 5e-11',
      // A complete t tail (pnp lastVbe lastVbc beta), so the untouched
      // transistor line saves byte-for-byte and only the scope edit matters.
      't 0 0 16 0 0 1 0 0 100',
      'o 0 64 6 4102 20 0.05 0 2 0 9 Tx',
      '',
    ].join('\n');
    useStore.getState().loadNetlist(NETLIST);
    const scope = useStore.getState().scopes[0];
    expect(scope.plots[1].value).toBeNull();
    expect(scope.plots[1].origValueToken).toBe(9);
    expect(useStore.getState().toNetlist()).toBe(NETLIST);

    useStore.getState().setScopeFlags(scope.id, { label: 'Td' });
    const saved = useStore.getState().toNetlist();
    expect(saved).toContain('o 0 64 6 4102 20 0.05 0 2 0 9 Td');
    useStore.getState().loadNetlist(saved);
    expect(useStore.getState().scopes[0].plots[1].value).toBeNull();
    expect(useStore.getState().toNetlist()).toBe(saved);
  });
});
