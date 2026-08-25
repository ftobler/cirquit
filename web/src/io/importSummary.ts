/** Live summary line for the Import From Text dialog, so the user sees what a
 *  load would bring in before committing to it. Pure and DOM-free. */

import { parseCircuit } from './netlist';

/** One-line summary of a netlist text: element and scope counts plus any types
 *  this build cannot interpret, e.g. "7 elements, 1 scope trace, 1 unsupported
 *  type(s) (999)". The wording is pinned by importSummary.test.ts; change the
 *  strings and the tests together. Text the parser refuses (XML-looking
 *  garbage that fails conversion) degrades to the failure reason instead of
 *  throwing, because the dialog renders this line on every keystroke. */
export function summarizeImport(text: string): string {
  let parsed: ReturnType<typeof parseCircuit>;
  try {
    parsed = parseCircuit(text);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const parts = [
    `${parsed.elements.length} element${parsed.elements.length === 1 ? '' : 's'}`,
    `${parsed.scopes.length} scope trace${parsed.scopes.length === 1 ? '' : 's'}`,
  ];
  if (parsed.unsupported.length) {
    const types = [...new Set(parsed.unsupported)].join(', ');
    parts.push(`${parsed.unsupported.length} unsupported type(s) (${types})`);
  }
  return parts.join(', ');
}

/** Whether the text parses into at least one element this build can construct,
 *  degrading to false when parseCircuit throws: XML-looking garbage fails
 *  conversion and must read as unloadable like any other refuse-to-parse text.
 *  Shared by both Paste memos and the import dialog so stored clipboard bytes
 *  can never take a render or a paste down with a thrown escape. */
export function parsesToElements(text: string): boolean {
  try {
    return parseCircuit(text).elements.length > 0;
  } catch {
    return false;
  }
}

/** Whether the Import From Text dialog's OK may load the text. Blank text is
 *  a deliberate empty sheet; non-blank text that parses to zero elements is
 *  garbage (a paste gone wrong), and loading it would silently replace the
 *  working circuit with nothing, so OK stays disabled until it parses. */
export function importIsLoadable(text: string): boolean {
  return text.trim() === '' || parsesToElements(text);
}
