/** The startup load chain, extracted from App.tsx so the fallbacks stay
 *  headless-testable. The precedence itself is `startupSource`'s (pure); this
 *  module owns the loads and their failures: a malformed share link falls back
 *  to the starter circuit with a status message and keeps its problem banner,
 *  because the engine started fine and only the circuit is broken. Nothing
 *  here may route a circuit failure into the engine-fatal page. */

import { loadDefaultCircuit, loadLibraryCircuit } from './library';
import { startupSource, type StartupSource } from './urlShare';

/** A small RC circuit, kept as the offline fallback for when the bundled
 *  library cannot be fetched, so the app still opens on something that runs. */
export const STARTER_CIRCUIT = `$ 1 0.000005 10.2 50 5 43 5e-11
v 176 320 176 96 0 0 40 5 0 0 0.5
r 176 96 384 96 0 1000
c 384 96 384 320 0 0.00001 0 0 0
w 384 320 176 320 0
g 176 320 176 352 0
o 2 64 0 4099
`;

export interface StartupDeps {
  /** Installs a parsed circuit; returns the failure message or null. */
  load(text: string): string | null;
  setStatus(message: string): void;
  /** Raises the refusal in BOTH banner channels: `problem` for immediate
   *  display, `unsupportedProblem` as the sticky seed the frame loop merges
   *  into every rebuild report. A message only in `problem` would be wiped by
   *  the starter circuit's first engine build one frame later. */
  setProblem(problem: string | null): void;
  /** False once the mounting effect has been torn down (React strict mode
   *  remounts); a late fetch must not load into a dead component. */
  alive(): boolean;
}

/** The library fetchers, injectable so tests never touch the network. */
export interface StartupIo {
  library(file: string): Promise<string>;
  default(): Promise<{ entry: { title: string }; netlist: string }>;
}

const defaultIo: StartupIo = { library: loadLibraryCircuit, default: loadDefaultCircuit };

export async function loadStartupCircuit(
  deps: StartupDeps,
  io: StartupIo = defaultIo,
  source: StartupSource = startupSource(),
): Promise<void> {
  if (source.kind === 'url') {
    const failure = deps.load(source.netlist);
    if (failure === null) return;
    // The failed load put its banner up; the starter fallback below would
    // wipe it, so the reason is re-asserted after the good circuit lands.
    deps.load(STARTER_CIRCUIT);
    if (!deps.alive()) return;
    deps.setStatus('Could not load the shared circuit; showing the starter circuit.');
    deps.setProblem(failure);
    return;
  }
  if (source.kind === 'file') {
    let text: string;
    try {
      text = await io.library(source.file);
    } catch {
      deps.load(STARTER_CIRCUIT);
      deps.setStatus(`Could not load ${source.file}; showing the starter circuit.`);
      return;
    }
    if (deps.alive()) deps.load(text);
    return;
  }
  let netlist: string;
  let title: string;
  try {
    const { entry, netlist: loaded } = await io.default();
    netlist = loaded;
    title = entry.title;
  } catch {
    // No status here: a missing library is not something the user asked for,
    // and the fallback circuit is usable on its own.
    deps.load(STARTER_CIRCUIT);
    return;
  }
  if (deps.alive()) {
    deps.load(netlist);
    // Name it the way the Circuits menu does, so the opening circuit reads as
    // a library entry rather than as anonymous scratch work.
    deps.setStatus(title);
  }
}
