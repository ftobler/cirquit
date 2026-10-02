/**
 * The scope dock: the strip of docked scope columns along the bottom, its
 * resize handle and column splitters, scope drag and drop, and the layer of
 * floating scope panels. Each scope is a panel with any number of plots;
 * scopes sharing a stacking position render into one column. The trace
 * canvas itself is ScopeTraceCanvas.tsx.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SimEngine } from '../engine/simulator';
import type { Scope } from '../engine/scopeModel';
import { defFor } from '../model/registry';
import { useStore } from '../state/store';
import { scopeColumns } from '../state/scopeLayout';
import { ScopeMenu } from './ScopeMenu';
import { ScopeProperties } from './ScopeProperties';
import { ScopeTraceCanvas } from './ScopeTraceCanvas';
import { FloatingScopeLayer, type DockDragApi } from './FloatingScopes';
import { SimInfoPanel } from './SimInfoPanel';
import {
  DEFAULT_STRIP_HEIGHT,
  MIN_STRIP_HEIGHT,
  clampStripHeight,
  loadStripHeight,
  saveStripHeight,
  dockedScopes,
} from './scopeStrip';
import { DEFAULT_FLOAT_H, DEFAULT_FLOAT_W, FLOAT_TITLE_H, clampFloatRect } from './floatingScopes';
import { columnWeights, dragSplitter } from './scopeColumns';
import { dropDecisionAt, type ColumnBox, type DropDecision } from './scopeDrag';
import { scopeDisplayName } from './scopePropsModel';

interface Props {
  engine: SimEngine | null;
}

/** Name for a plot's element, used in CSV headers and scope titles. */
function elementNameOf(
  elements: ReturnType<typeof useStore.getState>['elements'],
  elementId: number,
): string {
  const element = elements.find((e) => e.id === elementId);
  return element ? (defFor(element.kind)?.label ?? element.kind) : 'missing';
}

/**
 * The grab bar on the strip's top edge. Dragging it up grows the strip; a
 * double-click puts it back to the default; the arrow keys nudge it for
 * keyboard users. The height is stored once the drag ends, not per move.
 */
function StripResizeHandle({
  height,
  onResize,
  available,
}: {
  height: number;
  onResize: (h: number, persist: boolean) => void;
  available: () => number;
}) {
  const dragRef = useRef<{ pointerId: number; startY: number; startH: number; last: number } | null>(
    null,
  );
  // The stored height may exceed what a window shrunk since lets the CSS
  // max-height show; every gesture starts from the clamped, displayed value
  // so it has no dead zone.
  const shown = () => clampStripHeight(height, available());
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = shown();
    dragRef.current = { pointerId: e.pointerId, startY: e.clientY, startH: start, last: start };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.last = clampStripHeight(drag.startH + (drag.startY - e.clientY), available());
    onResize(drag.last, false);
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    // A cancelled or already lost pointer may no longer hold the capture,
    // and releasing it then throws on some browsers.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onResize(drag.last, true);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === 'ArrowUp') onResize(clampStripHeight(shown() + step, available()), true);
    else if (e.key === 'ArrowDown') onResize(clampStripHeight(shown() - step, available()), true);
    else return;
    e.preventDefault();
  };
  return (
    <div
      className="scope-strip-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize scopes"
      aria-valuenow={shown()}
      aria-valuemin={MIN_STRIP_HEIGHT}
      tabIndex={0}
      title="Drag to resize the scopes, double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      // Capture lost without a pointerup (a window blur, an OS gesture) must
      // end the drag too, or a later plain hover would keep resizing.
      onLostPointerCapture={end}
      onDoubleClick={() => onResize(DEFAULT_STRIP_HEIGHT, true)}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * The grab band between two docked scope columns. Dragging it moves width
 * from one neighbour to the other; a double-click shares the strip equally
 * again; the arrow keys nudge it. The band straddles the 1 px gap the
 * columns already leave, so the resting strip looks as before.
 */
function ColumnSplitter({
  index,
  weights,
  onChange,
  totalWidth,
}: {
  index: number;
  weights: number[];
  onChange: (w: number[]) => void;
  totalWidth: () => number;
}) {
  const dragRef = useRef<{ pointerId: number; x: number; start: number[] } | null>(null);
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const share = Math.round((weights[index] / weights.reduce((a, b) => a + b, 0)) * 100);
  return (
    <div
      className="scope-col-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize scope columns ${index + 1} and ${index + 2}`}
      aria-valuenow={share}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      title="Drag to resize the columns, double-click to share equally"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { pointerId: e.pointerId, x: e.clientX, start: weights };
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        onChange(dragSplitter(d.start, index, e.clientX - d.x, totalWidth()));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      // A capture lost without a pointerup must end the drag, or a later
      // plain hover would keep resizing.
      onLostPointerCapture={end}
      onDoubleClick={() => onChange(weights.map(() => 1))}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0;
        if (step === 0) return;
        e.preventDefault();
        onChange(dragSplitter(weights, index, e.shiftKey ? step * 4 : step, totalWidth()));
      }}
    />
  );
}

/** A scope being dragged: from the dock by its grip, or a floating panel by
 *  its title bar. `decision` is what a release here would do; `armed` turns
 *  on once a grip drag has moved a few pixels, so a stray click on the grip
 *  is not a drop. */
interface ScopeDrag {
  id: number;
  source: 'dock' | 'float';
  x: number;
  y: number;
  decision: DropDecision;
  armed: boolean;
}

/** How far a grip press must travel before it counts as a drag. */
const DRAG_THRESHOLD_PX = 4;

export function ScopePanel({ engine }: Props) {
  const scopes = useStore((s) => s.scopes);
  const floating = useStore((s) => s.floating);
  const elements = useStore((s) => s.elements);
  const scopeProperties = useStore((s) => s.scopeProperties);
  const closeScopeProperties = useStore((s) => s.closeScopeProperties);
  const [stripHeight, setStripHeight] = useState(loadStripHeight);
  const stripRef = useRef<HTMLDivElement>(null);
  // Column width shares, session-only, tagged with the column positions they
  // were made for. A stack, unstack, float or dock changes what the columns
  // are, and then the shares fall back to equal rather than reappearing on
  // columns they never belonged to.
  const [storedWeights, setStoredWeights] = useState<{ key: string; weights: number[] } | null>(
    null,
  );
  const scopesRef = useRef<HTMLDivElement>(null);
  const scopesWidth = useCallback(() => scopesRef.current?.clientWidth ?? 0, []);
  const [drag, setDrag] = useState<ScopeDrag | null>(null);
  // The column elements by stacking position, measured at drag time.
  const columnEls = useRef(new Map<number, HTMLDivElement>());
  const dockedRef = useRef<Scope[]>([]);

  /** The drop a release at (x, y) would make, from the live layout boxes. */
  const decide = useCallback((id: number, x: number, y: number): DropDecision => {
    const stripEl = stripRef.current;
    const r = stripEl?.getBoundingClientRect();
    const strip = r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
    const boxes: ColumnBox[] = [];
    for (const col of scopeColumns(dockedRef.current)) {
      const pos = dockedRef.current.find((s) => s.id === col[0])?.position;
      const el = pos === undefined ? undefined : columnEls.current.get(pos);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      boxes.push({ ids: col, left: b.left, right: b.right });
    }
    return dropDecisionAt(x, y, id, strip, boxes);
  }, []);

  /** Applies a drop. A dock decision moves (and docks) the scope; a float
   *  decision from the dock floats it under the pointer. */
  const applyDrop = useCallback((d: ScopeDrag) => {
    const st = useStore.getState();
    if (d.decision.kind === 'dock') {
      st.moveScope(d.id, d.decision.target);
      return;
    }
    if (d.source !== 'dock') return;
    const centre = stripRef.current?.parentElement?.getBoundingClientRect();
    if (!centre) return;
    st.floatScope(
      d.id,
      clampFloatRect(
        {
          x: d.x - centre.left - DEFAULT_FLOAT_W / 2,
          y: d.y - centre.top - FLOAT_TITLE_H / 2,
          w: DEFAULT_FLOAT_W,
          h: DEFAULT_FLOAT_H,
        },
        { w: centre.width, h: centre.height },
      ),
    );
  }, []);

  // The live grip drag's teardown, so an unmount mid-drag removes its window
  // listeners.
  const stopGripRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopGripRef.current?.(), []);

  // A grip drag follows the pointer through window listeners, so it keeps
  // tracking over the schematic, the floating panels and the strip alike.
  // Escape cancels it.
  const startGripDrag = useCallback(
    (id: number, e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const pointerId = e.pointerId;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let current: ScopeDrag = {
        id,
        source: 'dock',
        x: x0,
        y: y0,
        decision: decide(id, x0, y0),
        armed: false,
      };
      const stop = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        stopGripRef.current = null;
        setDrag(null);
      };
      stopGripRef.current = stop;
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        // No button held means the release was lost (an alt-tab mid-drag):
        // end quietly rather than arm the next ordinary click as a drop.
        if (ev.buttons === 0) {
          stop();
          return;
        }
        const armed =
          current.armed || Math.hypot(ev.clientX - x0, ev.clientY - y0) >= DRAG_THRESHOLD_PX;
        current = {
          ...current,
          x: ev.clientX,
          y: ev.clientY,
          decision: decide(id, ev.clientX, ev.clientY),
          armed,
        };
        if (armed) setDrag(current);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        stop();
        if (current.armed) applyDrop(current);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) stop();
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return;
        // Escape ends the drag only; the dialogs and menus listening for it
        // must not also close underneath.
        ev.stopPropagation();
        stop();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
    },
    [decide, applyDrop],
  );

  // A floating panel's title drag: the panel moves itself; the dock only
  // shows a marker while the pointer is over the strip and takes the panel
  // in on a release there.
  const dockDrag = useMemo<DockDragApi>(
    () => ({
      move: (id, x, y) => {
        const decision = decide(id, x, y);
        // Only a changed decision re-renders the dock; the marker does not
        // follow the pointer, so the coordinates alone do not matter.
        setDrag((prev) => {
          if (decision.kind !== 'dock') return prev?.source === 'float' ? null : prev;
          if (prev?.source === 'float' && JSON.stringify(prev.decision) === JSON.stringify(decision)) {
            return prev;
          }
          return { id, source: 'float', x, y, decision, armed: true };
        });
      },
      drop: (id, x, y) => {
        setDrag(null);
        const decision = decide(id, x, y);
        if (decision.kind === 'dock') applyDrop({ id, source: 'float', x, y, decision, armed: true });
      },
      cancel: () => setDrag((prev) => (prev?.source === 'float' ? null : prev)),
    }),
    [decide, applyDrop],
  );

  const resizeStrip = useCallback((h: number, persist: boolean) => {
    setStripHeight(h);
    if (persist) saveStripHeight(h);
  }, []);
  // The centre area's height, the share the clamp works against. Read on
  // demand, since only a drag or a key press needs it.
  const availableHeight = useCallback(
    () => stripRef.current?.parentElement?.clientHeight ?? 0,
    [],
  );

  if (scopes.length === 0) return null;

  // Floating scopes draw in their own panels over the schematic; the dock
  // shows the rest, and folds away entirely once every scope floats.
  const docked = dockedScopes(scopes, floating);
  // Group panels by stacking position; each position is one flex column.
  const positions = [...new Set(docked.map((x) => x.position))].sort((a, b) => a - b);
  const columnsKey = positions.join(',');
  const weights = columnWeights(
    storedWeights?.key === columnsKey ? storedWeights.weights : null,
    positions.length,
  );
  const setWeights = (w: number[]) => setStoredWeights({ key: columnsKey, weights: w });
  dockedRef.current = docked;
  const stripBox = stripRef.current?.getBoundingClientRect();

  return (
    <>
      {docked.length > 0 && (
        // The stored height can exceed a window shrunk since; the CSS
        // max-height keeps the schematic visible without rewriting it.
        <div ref={stripRef} className="bottom-strip" style={{ height: stripHeight }}>
          <StripResizeHandle
            height={stripHeight}
            onResize={resizeStrip}
            available={availableHeight}
          />
          <div ref={scopesRef} className="scopes">
            {positions.map((pos, i) => (
              <Fragment key={pos}>
                {i > 0 && (
                  <ColumnSplitter
                    index={i - 1}
                    weights={weights}
                    onChange={setWeights}
                    totalWidth={scopesWidth}
                  />
                )}
                <div
                  ref={(el) => {
                    if (el) columnEls.current.set(pos, el);
                    else columnEls.current.delete(pos);
                  }}
                  className={
                    drag?.decision.kind === 'dock' &&
                    drag.decision.marker.type === 'column' &&
                    drag.decision.marker.index === i
                      ? 'scope-col drop-target'
                      : 'scope-col'
                  }
                  style={{ flex: `${weights[i]} 1 0px` }}
                >
                  {docked
                    .filter((x) => x.position === pos)
                    .map((scope) => (
                      <ScopeTraceCanvas
                        key={scope.id}
                        engine={engine}
                        scope={scope}
                        onGrip={startGripDrag}
                      />
                    ))}
                </div>
              </Fragment>
            ))}
          </div>
          <SimInfoPanel engine={engine} />
          {drag?.decision.kind === 'dock' && drag.decision.marker.type === 'gap' && stripBox && (
            // The insertion bar where a new column would open.
            <div
              className="scope-drop-gap"
              style={{ left: drag.decision.marker.x - stripBox.left }}
            />
          )}
        </div>
      )}
      {drag?.source === 'dock' && (
        // The dragged scope's name under the pointer, saying what a release
        // here would do.
        <div className="scope-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>
          {scopeDisplayName(scopes, scopes.find((x) => x.id === drag.id) ?? scopes[0])}
          {drag.decision.kind === 'float'
            ? ' · float here'
            : drag.decision.target.kind === 'stack'
              ? ' · stack'
              : ' · new column'}
        </div>
      )}
      <FloatingScopeLayer engine={engine} dock={dockDrag} />
      <ScopeMenu engine={engine} nameOf={(plot) => elementNameOf(elements, plot.elementId)} />
      {scopeProperties !== null && (
        // Keyed by the scope: the stack tabs switch which scope the open
        // dialog edits, and the label and trigger-level boxes hold their text
        // in local state, so the panel has to remount rather than keep the
        // previous scope's text over the new scope's values.
        <ScopeProperties
          key={scopeProperties}
          scopeId={scopeProperties}
          onClose={closeScopeProperties}
        />
      )}
    </>
  );
}
