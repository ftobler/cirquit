/**
 * The scope popup menu, opened by a right-click over a scope canvas. Reuses
 * the element context menu's `.dropdown-menu`/`.menu-item` styles and its
 * positioning/dismissal pattern; every command is a store action.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { SimEngine } from '../engine/simulator';
import type { DrawablePlot } from '../scope/draw';
import { exportScopeCsv } from '../scope/draw';
import { scopeWidth } from '../scope/geometry';
import { clearScaleStates } from '../scope/scale';
import { scopeMenuRows, type ScopeMenuRow } from './scopeMenuRows';
import { useStore } from '../state/store';

interface Props {
  engine: SimEngine | null;
  nameOf: (plot: DrawablePlot) => string;
}

/** Downloads text as a file, the same Blob pattern as the clipboard write. */
function downloadTextFile(data: string, filename: string): void {
  const blob = new Blob([data], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ScopeMenu({ engine, nameOf }: Props) {
  const scopeMenu = useStore((s) => s.scopeMenu);
  const closeScopeMenu = useStore((s) => s.closeScopeMenu);
  const scopes = useStore((s) => s.scopes);
  const settings = useStore((s) => s.settings);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!scopeMenu) return;
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(4, Math.min(scopeMenu.x, window.innerWidth - w - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(scopeMenu.y, window.innerHeight - h - 4))}px`;
  }, [scopeMenu]);

  useEffect(() => {
    if (!scopeMenu) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (ref.current && ev.target instanceof Node && ref.current.contains(ev.target)) return;
      closeScopeMenu();
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeScopeMenu();
    };
    const onScroll = () => closeScopeMenu();
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [scopeMenu, closeScopeMenu]);

  if (!scopeMenu) return null;
  const scope = scopes.find((x) => x.id === scopeMenu.scopeId);
  if (!scope) return null;

  const run = (action: () => void) => {
    closeScopeMenu();
    action();
  };

  const scopeIndex = scopes.findIndex((x) => x.id === scope.id);
  const previous = scopeIndex > 0 ? scopes[scopeIndex - 1] : undefined;

  const item = (m: ScopeMenuRow) => (
    <button
      key={m.label}
      type="button"
      className="menu-item"
      role="menuitem"
      disabled={m.disabled}
      onClick={() => run(m.action)}
    >
      <span>{m.label}</span>
    </button>
  );

  const st = useStore.getState();
  // The row table is pure and node-tested; this is the only place the store
  // actions, the CSV build and the download meet it.
  const items: ScopeMenuRow[] = scopeMenuRows({
    scope,
    previous,
    plotId: scopeMenu.plotId,
    exportCsv: () => {
      if (!engine) return;
      const width = scopeWidth(scope.id) ?? 500;
      const csv = exportScopeCsv(
        engine,
        scope,
        nameOf,
        width,
        scope.speed,
        settings.timeStep,
        engine.time,
      );
      downloadTextFile(csv, 'scope-data.csv');
    },
    commands: {
      removeScope: st.removeScope,
      setScopeFlags: st.setScopeFlags,
      stackScope: st.stackScope,
      unstackScope: st.unstackScope,
      combineScopes: st.combineScopes,
      removePlot: st.removePlot,
      clearScaleStates,
      resetScope: st.resetScope,
      openScopeProperties: st.openScopeProperties,
    },
  });

  return (
    <div
      ref={ref}
      className="dropdown-menu context-menu"
      role="menu"
      style={{ left: scopeMenu.x, top: scopeMenu.y }}
    >
      {/* The same command-column wrapper the canvas context menu uses: the
        shared shell is a flex row (it holds two columns over empty canvas),
        so a bare run of rows in it would lay out sideways and be clipped. */}
      <div className="context-commands">{items.map(item)}</div>
    </div>
  );
}
