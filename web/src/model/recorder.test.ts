import { describe, expect, it } from 'vitest';
import { dataTimestamp, recorderDataText, recorderFilename } from './recorder';

describe('data recorder export helpers', () => {
  it('builds the header and one sample per line', () => {
    expect(recorderDataText([1.5, 2.25, 3], 5e-6)).toBe(
      '# time step = 0.000005 sec\n1.5\n2.25\n3\n',
    );
  });

  it('an empty ring exports just the header', () => {
    expect(recorderDataText([], 1e-5)).toBe('# time step = 0.00001 sec\n');
  });

  it('formats the timestamp as yyyyMMdd-HHmm', () => {
    expect(dataTimestamp(new Date(2026, 7, 12, 9, 5))).toBe('20260812-0905');
    expect(dataTimestamp(new Date(2026, 0, 3, 23, 59))).toBe('20260103-2359');
  });

  it('names the file data-YYYYMMDD-HHmm.circuitjs.txt', () => {
    expect(recorderFilename(new Date(2026, 7, 12, 14, 30))).toBe('data-20260812-1430.circuitjs.txt');
  });
});
