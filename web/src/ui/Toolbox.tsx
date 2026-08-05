/** Element picker, grouped by category. */

import { CATEGORIES, ELEMENT_DEFS } from '../model/registry';
import { useStore } from '../state/store';

export function Toolbox() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);

  return (
    <div className="toolbox">
      {CATEGORIES.map((category) => {
        const defs = ELEMENT_DEFS.filter((d) => d.category === category);
        if (defs.length === 0) return null;
        return (
          <section key={category}>
            <h3>{category}</h3>
            <div className="tool-grid">
              {defs.map((d) => (
                <button
                  key={d.kind}
                  type="button"
                  className={tool === d.kind ? 'tool active' : 'tool'}
                  onClick={() => setTool(tool === d.kind ? null : d.kind)}
                  title={`Place a ${d.label.toLowerCase()}`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </section>
        );
      })}
      <p className="hint">
        Pick a part, then drag on the canvas to place it. Shift-drag pans, the wheel zooms, and
        clicking a switch while running throws it.
      </p>
    </div>
  );
}
