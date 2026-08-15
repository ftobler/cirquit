/** Element picker, grouped by category, with a search bar, a live icon per
 *  tool drawn from its own element definition, and the placement shortcut. */

import { useState } from 'react';
import { CATEGORIES } from '../model/registry';
import { filterTools, toolShortcut } from '../model/search';
import { useStore } from '../state/store';
import { toolTileClass } from './controlClasses';
import { ToolIcon } from './ToolIcon';

export function Toolbox() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const editable = useStore((s) => s.settings.editable);
  const dark = useStore((s) => s.dark);
  const settings = useStore((s) => s.settings);
  const [query, setQuery] = useState('');

  const tools = filterTools(query);
  const searching = query.trim() !== '';

  return (
    <div className="toolbox">
      <input
        type="text"
        className="tool-search"
        aria-label="Search tools"
        placeholder="Search tools…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {CATEGORIES.map((category) => {
        const entries = tools.filter((t) => t.category === category);
        if (entries.length === 0) return null;
        return (
          <section key={category}>
            <h3>{category}</h3>
            <div className="tool-grid">
              {entries.map((t) => {
                const shortcut = toolShortcut(t);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={toolTileClass(tool === t.id)}
                    disabled={!editable}
                    onClick={() => setTool(tool === t.id ? null : t.id)}
                    title={editable ? `Place a ${t.label.toLowerCase()}` : 'Editing is disabled'}
                  >
                    <ToolIcon toolId={t.id} dark={dark} settings={settings} />
                    <span className="tool-label">{t.label}</span>
                    {shortcut && (
                      <kbd className="tool-shortcut" aria-hidden="true">
                        {shortcut}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      {searching && tools.length === 0 && <p className="hint">No tools match “{query.trim()}”</p>}
      <p className="hint">
        Pick a part, then drag on the canvas to place it. Shift-drag pans, the wheel zooms, and
        clicking a switch while running throws it.
      </p>
    </div>
  );
}
