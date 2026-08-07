/** Element picker, grouped by category. */

import { CATEGORIES, TOOLBOX } from '../model/registry';
import { useStore } from '../state/store';

export function Toolbox() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const editable = useStore((s) => s.settings.editable);

  return (
    <div className="toolbox">
      {CATEGORIES.map((category) => {
        const entries = TOOLBOX.filter((t) => t.category === category);
        if (entries.length === 0) return null;
        return (
          <section key={category}>
            <h3>{category}</h3>
            <div className="tool-grid">
              {entries.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={tool === t.id ? 'tool active' : 'tool'}
                  disabled={!editable}
                  onClick={() => setTool(tool === t.id ? null : t.id)}
                  title={editable ? `Place a ${t.label.toLowerCase()}` : 'Editing is disabled'}
                >
                  {t.label}
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
