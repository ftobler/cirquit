/** The docs side-pages entry point, shared by every `web/pages/*.html` entry
 *  file. Dispatches on the `<body data-page>` attribute, sets the docs-root
 *  class that lets the prose scroll (the app's `body { overflow: hidden }`
 *  would otherwise clip it), and renders the layout plus the page component.
 *
 *  All pages share one entry chunk: the docs are small, and the registry and
 *  layout stay consistent by construction. */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/roboto';
import '../styles.css';
import './docs.css';
import { DOC_PAGES } from './pages';
import { DocsLayout } from './DocsLayout';
import { DocsIndexPage } from './pages/DocsIndexPage';
import { AudioInputPage, DataInputPage, DelayBufferPage } from './pages/elementGuides';
import { CrystalCalcPage, DiodeCalcPage, MosfetBetaPage } from './pages/calculators';
import {
  CustomFunctionPage,
  CustomLogicPage,
  CustomTransformerPage,
  OpAmpRealPage,
  SubcircuitsPage,
} from './pages/reference';

const PAGES: Record<string, () => React.JSX.Element> = {
  docs: DocsIndexPage,
  subcircuits: SubcircuitsPage,
  customLogic: CustomLogicPage,
  customFunction: CustomFunctionPage,
  customTransformer: CustomTransformerPage,
  opampReal: OpAmpRealPage,
  crystalCalc: CrystalCalcPage,
  diodeCalc: DiodeCalcPage,
  mosfetBeta: MosfetBetaPage,
  audioInput: AudioInputPage,
  dataInput: DataInputPage,
  delayBuffer: DelayBufferPage,
};

const id = document.body.dataset.page ?? '';
// The docs-root class must be in place before the first render, or the prose
// is clipped for a frame.
document.body.classList.add('docs-root');
const Page = PAGES[id] ?? null;
const title = DOC_PAGES.find((p) => p.id === id)?.title ?? 'Documentation';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <DocsLayout id={id} title={title}>
      {Page ? <Page /> : <p className="docs-muted">Unknown page: {id}</p>}
    </DocsLayout>
  </StrictMode>,
);
