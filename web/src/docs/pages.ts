/**
 * The docs side-pages registry, the single source of truth for the multi-page
 * build. Pure data, no JSX, so the rollup input (`vite.config.ts`), the
 * `data-page` HTML entry files, the DocsLayout nav, the docs index and the
 * Menubar Help dropdown all share one list, and `pages.test.ts` closes the
 * loop between the registry, the HTML files and the build.
 *
 * `file` names upstream's pages where one exists (`subcircuits.html`,
 * `crystal.html`, ...), so upstream-format links to the same page keep
 * working. The element guides are new files (upstream's live in `doc/` as
 * `AudioInput.html`, `DataInput.html`, `DelayBuffer.html`).
 */

export interface DocPage {
  /** Matches the `data-page` attribute on the HTML entry file. */
  id: string;
  /** The output/HTML file, e.g. 'subcircuits.html'. */
  file: string;
  title: string;
  group: 'Reference' | 'Calculators' | 'Elements';
  /** A direct row in the app Help menu. */
  menu?: boolean;
}

export const DOC_PAGES: DocPage[] = [
  // The index page's group is unused by the index itself (it lists every
  // other page), but the union type has no 'Index', so it claims Reference.
  { id: 'docs', file: 'docs.html', title: 'Documentation', group: 'Reference', menu: true },
  { id: 'subcircuits', file: 'subcircuits.html', title: 'Subcircuits', group: 'Reference', menu: true },
  { id: 'customLogic', file: 'customlogic.html', title: 'Custom Logic', group: 'Reference' },
  { id: 'customFunction', file: 'customfunction.html', title: 'Controlled Source Output Function', group: 'Reference' },
  { id: 'customTransformer', file: 'customtransformer.html', title: 'Custom Transformer', group: 'Reference' },
  { id: 'opampReal', file: 'opampreal.html', title: 'Real Op-Amps', group: 'Reference' },
  { id: 'crystalCalc', file: 'crystal.html', title: 'Crystal Calculator', group: 'Calculators', menu: true },
  { id: 'diodeCalc', file: 'diodecalc.html', title: 'Diode/LED Model Calculator', group: 'Calculators', menu: true },
  { id: 'mosfetBeta', file: 'mosfet-beta.html', title: 'MOSFET Beta Calculator', group: 'Calculators', menu: true },
  { id: 'audioInput', file: 'audio-input.html', title: 'Audio Input Element', group: 'Elements' },
  { id: 'dataInput', file: 'data-input.html', title: 'Data Input Element', group: 'Elements' },
  { id: 'delayBuffer', file: 'delay-buffer.html', title: 'Delay Buffer Element', group: 'Elements' },
];
