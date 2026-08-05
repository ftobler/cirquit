import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { SimEngine } from '../engine/simulator';
import { generateReport, formatReport } from './corpus';

const CIRCUITS_DIR = fileURLToPath(new URL('../../public/circuits', import.meta.url));
const REPORT_PATH = fileURLToPath(new URL('./corpus-report.json', import.meta.url));

// `just corpus` runs this file with CORPUS_UPDATE=1: it regenerates the
// committed golden report and prints the summary. The normal test run skips it
// so the report is only ever written on purpose, never by `just ci`.
describe.skipIf(process.env.CORPUS_UPDATE !== '1')('corpus report', () => {
  it('regenerates the golden report and prints the summary', async () => {
    const engine = await SimEngine.create();
    const report = generateReport(CIRCUITS_DIR, engine);
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
    console.log(formatReport(report));
  }, 180_000);
});
