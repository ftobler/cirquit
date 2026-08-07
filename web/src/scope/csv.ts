/**
 * CSV export for a scope, reproducing Scope.exportCSV (Scope.java:1143-1178):
 * one row per display pixel, `time` then per plot `"<name> <unit> min"` and
 * `"<name> <unit> max"`, rows with `t < 0` skipped. The plot columns are the
 * visible window, oldest first, so row i lines up with pixel i.
 */

export interface CsvPlot {
  name: string;
  unit: string;
  min: ArrayLike<number>;
  max: ArrayLike<number>;
}

export function buildCsv(
  plots: CsvPlot[],
  speed: number,
  timeStep: number,
  simTime: number,
  widthPx: number,
): string {
  const ts = speed * timeStep;
  const tStart = simTime - ts * widthPx;
  const lines: string[] = [];
  lines.push(
    ['time', ...plots.flatMap((p) => [`"${p.name} ${p.unit} min"`, `"${p.name} ${p.unit} max"`])].join(
      ',',
    ),
  );
  for (let i = 0; i < widthPx; i++) {
    const t = tStart + ts * i;
    if (t < 0) continue;
    const row = [t];
    for (const p of plots) {
      row.push(p.min[i] ?? 0, p.max[i] ?? 0);
    }
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}
