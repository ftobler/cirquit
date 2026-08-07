/** About: what this is, the version, the licence and the upstream attribution
 *  the GPL-2.0 licence requires. Static text instead of upstream's iframe, a
 *  form difference with the same function. */

import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function AboutDialog() {
  const closeDialog = useStore((s) => s.closeDialog);

  return (
    <Dialog
      title="About Circuit Simulator"
      onClose={closeDialog}
      actions={
        <button type="button" onClick={closeDialog}>
          OK
        </button>
      }
    >
      <p>
        An interactive electronic circuit simulator that runs entirely in the browser. The
        simulation engine (MNA solver, Newton-Raphson iteration, device models) is written in
        Rust and compiled to WebAssembly; the interface is React.
      </p>
      <p>Version 0.1.0.</p>
      <p>
        This is a derivative work of{' '}
        <a href="https://github.com/pfalstad/circuitjs1" target="_blank" rel="noreferrer">
          Falstad's CircuitJS1
        </a>
        , and is licensed under the GNU General Public License version 2.0 or later. The bundled
        example circuits keep their upstream attribution.
      </p>
    </Dialog>
  );
}
