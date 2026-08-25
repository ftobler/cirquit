/** I-M1: the startup chain's failure shapes. A bad share link must fall back
 *  to the starter circuit with a status message and keep its parse banner,
 *  never reach the engine-fatal page; the library fallbacks keep their own
 *  messages. Runs against the extracted io/startup.ts with fake fetchers, so
 *  no network and no React. */

import { describe, expect, it } from 'vitest';
import { STARTER_CIRCUIT, loadStartupCircuit, type StartupDeps, type StartupIo } from './startup';
import type { StartupSource } from './urlShare';

const GOOD = '$ 1 0.000005 10 50 5 5 1e-9\nr 0 0 160 0 0 1000\n';

function harness(source: StartupSource, loadImpl: (text: string) => string | null) {
  const loads: string[] = [];
  const statuses: string[] = [];
  const problems: (string | null)[] = [];
  const deps: StartupDeps = {
    load: (text) => {
      loads.push(text);
      return loadImpl(text);
    },
    setStatus: (m) => statuses.push(m),
    setProblem: (p) => problems.push(p),
    alive: () => true,
  };
  return { loads, statuses, problems, deps };
}

const okLoad = () => null;

describe('startup chain', () => {
  it('a good share link loads and says nothing', async () => {
    const h = harness({ kind: 'url', netlist: GOOD }, okLoad);
    await loadStartupCircuit(h.deps, undefined, { kind: 'url', netlist: GOOD });
    expect(h.loads).toEqual([GOOD]);
    expect(h.statuses).toEqual([]);
    expect(h.problems).toEqual([]);
  });

  it('a malformed share link falls back to the starter circuit with a status message and keeps the banner', async () => {
    // The store-level routing reports the failure as a value and puts the
    // banner up; simulate both halves here.
    const h = harness({ kind: 'url', netlist: '<cir broken>' }, (text) =>
      text === STARTER_CIRCUIT ? null : 'Could not load the circuit: xml: unclosed element <cir>',
    );
    await loadStartupCircuit(h.deps, undefined, { kind: 'url', netlist: '<cir broken>' });
    expect(h.loads[0]).toBe('<cir broken>');
    expect(h.loads[1]).toBe(STARTER_CIRCUIT);
    expect(h.statuses).toEqual(['Could not load the shared circuit; showing the starter circuit.']);
    // The banner survives the fallback load that would otherwise clear it.
    expect(h.problems).toEqual(['Could not load the circuit: xml: unclosed element <cir>']);
  });

  it('a failed library deep link falls back to the starter circuit and names the file', async () => {
    const h = harness({ kind: 'file', file: 'led.txt' }, okLoad);
    const io: StartupIo = {
      library: () => Promise.reject(new Error('404')),
      default: () => Promise.reject(new Error('unused')),
    };
    await loadStartupCircuit(h.deps, io, { kind: 'file', file: 'led.txt' });
    expect(h.loads).toEqual([STARTER_CIRCUIT]);
    expect(h.statuses).toEqual(['Could not load led.txt; showing the starter circuit.']);
  });

  it('the default library entry loads and is named by its title', async () => {
    const h = harness({ kind: 'starter' }, okLoad);
    const io: StartupIo = {
      library: () => Promise.reject(new Error('unused')),
      default: () => Promise.resolve({ entry: { title: 'LED Example' }, netlist: GOOD }),
    };
    await loadStartupCircuit(h.deps, io, { kind: 'starter' });
    expect(h.loads).toEqual([GOOD]);
    expect(h.statuses).toEqual(['LED Example']);
  });

  it('a missing default library quietly falls back to the starter circuit', async () => {
    const h = harness({ kind: 'starter' }, okLoad);
    const io: StartupIo = {
      library: () => Promise.reject(new Error('unused')),
      default: () => Promise.reject(new Error('offline')),
    };
    await loadStartupCircuit(h.deps, io, { kind: 'starter' });
    expect(h.loads).toEqual([STARTER_CIRCUIT]);
    expect(h.statuses).toEqual([]);
  });

  it('a teardown between the fetch and the load installs nothing', async () => {
    let alive = true;
    const loads: string[] = [];
    const deps: StartupDeps = {
      load: (text) => {
        loads.push(text);
        return null;
      },
      setStatus: () => {},
      setProblem: () => {},
      alive: () => alive,
    };
    const io: StartupIo = {
      library: () => Promise.resolve(GOOD),
      default: () => Promise.reject(new Error('unused')),
    };
    const pending = loadStartupCircuit(deps, io, { kind: 'file', file: 'a.txt' });
    alive = false;
    await pending;
    expect(loads).toEqual([]);
  });
});
