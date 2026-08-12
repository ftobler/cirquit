import { describe, expect, it } from 'vitest';
import { parseDataFile } from './dataFile';

describe('parseDataFile', () => {
  it('parses one numeric value per line', () => {
    const parsed = parseDataFile('1.5\n2.3\n-0.5\n');
    expect(parsed.error).toBeNull();
    expect(parsed.samples).toEqual([1.5, 2.3, -0.5]);
  });

  it('skips blank lines and # comments', () => {
    const parsed = parseDataFile('# my data\n\n1.5\n\n# comment\n2.3\n');
    expect(parsed.error).toBeNull();
    expect(parsed.samples).toEqual([1.5, 2.3]);
  });

  it('splits on CRLF line endings', () => {
    const parsed = parseDataFile('1.5\r\n2.3\r\n');
    expect(parsed.error).toBeNull();
    expect(parsed.samples).toEqual([1.5, 2.3]);
  });

  it('reports a parse error on a bad line, naming the line', () => {
    const parsed = parseDataFile('1.5\nnot-a-number\n2.3\n');
    expect(parsed.error).toContain('Error parsing data file');
    expect(parsed.error).toContain('Expected format');
    expect(parsed.error).toContain('One numeric voltage value per line');
    expect(parsed.error).toContain('Lines starting with # are treated as comments');
    expect(parsed.error).toContain('Blank lines are ignored');
    expect(parsed.error).toContain('Example:');
  });

  it('reports "No data found" when the file holds nothing but comments', () => {
    const parsed = parseDataFile('# nothing here\n\n');
    expect(parsed.error).toContain('No data found in file');
    expect(parsed.error).toContain('Expected format');
  });

  it('reports an error on an empty file', () => {
    const parsed = parseDataFile('');
    expect(parsed.error).toContain('No data found in file');
  });
});
