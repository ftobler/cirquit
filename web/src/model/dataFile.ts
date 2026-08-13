/**
 * The data-input file format: one numeric voltage value per line, blank lines
 * and `#` comments skipped (DataInputElm.java:185-216). Pure and DOM-free so
 * it is testable headlessly; the file field in the element edit dialog feeds
 * the decoded text in and, on an error, shows the same message upstream alerts.
 */

export interface DataFileParse {
  /** The numeric values, in file order, when the file parsed cleanly. */
  samples: number[];
  /** The reason loading must fail, or null when `samples` is usable. */
  error: string | null;
}

/** The shared "Expected format" help upstream alerts on a bad data file
 *  (DataInputElm.java:208-213). */
const EXPECTED_FORMAT =
  'Expected format:\n' +
  '- One numeric voltage value per line\n' +
  '- Lines starting with # are treated as comments\n' +
  '- Blank lines are ignored\n\n' +
  'Example:\n# my data\n1.5\n2.3\n-0.5';

export function parseDataFile(text: string): DataFileParse {
  const samples: number[] = [];
  let parseError = false;
  const lines = text.split(/\r*\n/);
  for (let i = 0; i < lines.length; i++) {
    // skip blank lines
    if (lines[i].length === 0) continue;
    // skip comments
    if (lines[i].charAt(0) === '#') continue;
    const d = Number(lines[i]);
    if (Number.isFinite(d)) {
      samples.push(d);
    } else {
      console.log('parse error on line ' + i);
      parseError = true;
    }
  }
  if (samples.length === 0 || parseError) {
    const msg = parseError ? 'Error parsing data file.\n\n' : 'No data found in file.\n\n';
    return { samples, error: msg + EXPECTED_FORMAT };
  }
  return { samples, error: null };
}
