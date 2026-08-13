/** About: what this is, the version, the licence and the upstream attribution
 *  the GPL-2.0 licence requires. Static text instead of upstream's iframe, a
 *  form difference with the same function. */

import { useStore } from '../state/store';
import { staticDeploymentUrl } from './about';
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
      <p>
        This is a derivative work of{' '}
        <a href="https://github.com/pfalstad/circuitjs1" target="_blank" rel="noreferrer">
          Falstad's CircuitJS1
        </a>
        . The source for this project lives at{' '}
        <a href="https://github.com/ftobler/cirquit" target="_blank" rel="noreferrer">
          github.com/ftobler/cirquit
        </a>
        . It is licensed under the GNU General Public License version 2.0 or later, and the bundled
        example circuits keep their upstream attribution.
      </p>
      <p>
        {/* The zip is built with no base path so it hosts at any domain root;
         * on the dev server BASE_URL is `/` and no zip exists, so the link
         * 404s until the site is deployed. */}
        <a href={staticDeploymentUrl(import.meta.env.BASE_URL)} download>
          Download the static deployment
        </a>
      </p>
    </Dialog>
  );
}
