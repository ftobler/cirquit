/**
 * Scopes floating over the schematic: movable, resizable panels inside the
 * app, each holding the same trace canvas the dock uses. The geometry lives
 * in floatingScopes.ts; this file draws the panels and runs their drags.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SimEngine } from '../engine/simulator';
import type { Scope } from '../engine/scopeModel';
import { useStore } from '../state/store';
import {
  clampFloatRect,
  defaultFloatRect,
  movedRect,
  resizedRect,
  type Bounds,
  type FloatRect,
} from './floatingScopes';
import { scopeDisplayName } from './scopePropsModel';
import { ScopeTraceCanvas } from './ScopeTraceCanvas';

/** What a floating panel's title drag reports to the dock, so the dock can
 *  show where the panel would land and take it in on release. */
export interface DockDragApi {
  move(id: number, x: number, y: number): void;
  drop(id: number, x: number, y: number): void;
  cancel(): void;
}

/** An in-progress title-bar move or corner resize. */
interface FloatDrag {
  pointerId: number;
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  start: FloatRect;
}

/**
 * One scope floating over the schematic: a title bar to drag it by (a
 * double-click docks it), dock and close buttons, the trace canvas, and a
 * grip in the bottom-right corner to resize it. Pressing anywhere on the
 * panel raises it. Moves update the store directly; none of it is an edit.
 */
function FloatingScope({
  engine,
  scope,
  title,
  rect,
  z,
  bounds,
  dock,
}: {
  engine: SimEngine | null;
  scope: Scope;
  title: string;
  rect: FloatRect;
  z: number;
  bounds: () => Bounds;
  dock: DockDragApi;
}) {
  const dragRef = useRef<FloatDrag | null>(null);
  const begin = (mode: FloatDrag['mode']) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // A press on a title-bar button is a click, not a drag.
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, mode, startX: e.clientX, startY: e.clientY, start: rect };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const next =
      drag.mode === 'move'
        ? movedRect(drag.start, dx, dy, bounds())
        : resizedRect(drag.start, dx, dy, bounds());
    useStore.getState().setFloatRect(scope.id, next);
    // A title drag over the strip shows where the panel would dock.
    if (drag.mode === 'move') dock.move(scope.id, e.clientX, e.clientY);
  };
  const end = (e: React.PointerEvent<HTMLDivElement>, dropped: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Only a real release drops; a cancel or a lost capture just clears the
    // marker. A release over the strip docks the panel there.
    if (drag.mode !== 'move') return;
    if (dropped) dock.drop(scope.id, e.clientX, e.clientY);
    else dock.cancel();
  };
  const handlers = (mode: FloatDrag['mode']) => ({
    onPointerDown: begin(mode),
    onPointerMove: onMove,
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => end(e, true),
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => end(e, false),
    // A capture lost without a pointerup (window blur) must end the drag,
    // or a later plain hover would keep moving the panel.
    onLostPointerCapture: (e: React.PointerEvent<HTMLDivElement>) => end(e, false),
  });
  return (
    <section
      className="scope-float"
      aria-label={title}
      // Stacking is a z-index, never DOM order: moving the node would drop
      // the pointer capture a drag took in this very press.
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z }}
      onPointerDownCapture={() => useStore.getState().raiseFloatingScope(scope.id)}
    >
      <div
        className="scope-float-title"
        {...handlers('move')}
        onDoubleClick={() => useStore.getState().dockScope(scope.id)}
        title="Drag to move or onto the scope strip to dock, double-click to dock"
      >
        <span className="scope-float-name">{title}</span>
        <button
          type="button"
          aria-label="Scope properties"
          title="Properties"
          onClick={() => useStore.getState().openScopeProperties(scope.id)}
        >
          ⚙
        </button>
        <button
          type="button"
          aria-label="Dock scope"
          title="Dock"
          onClick={() => useStore.getState().dockScope(scope.id)}
        >
          ⤓
        </button>
        <button
          type="button"
          aria-label="Remove scope"
          title="Remove scope"
          onClick={() => useStore.getState().removeScope(scope.id)}
        >
          ×
        </button>
      </div>
      {/* A float or dock remounts the canvas, which resets an X-Y scope's
          persistence trail and autoscale: display caches keyed to the
          canvas, rebuilt within a sweep. */}
      <ScopeTraceCanvas engine={engine} scope={scope} floating />
      <div className="scope-float-grip" aria-hidden="true" {...handlers('resize')} />
    </section>
  );
}

/**
 * The layer the floating panels live in: it covers the centre area (the
 * schematic and the dock) without taking pointer input itself, so the
 * schematic underneath stays fully usable between panels. Its size is the
 * bounds every panel is clamped to, so a shrinking window pulls panels back
 * in rather than losing them off the edge.
 */
export function FloatingScopeLayer({ engine, dock }: { engine: SimEngine | null; dock: DockDragApi }) {
  const scopes = useStore((s) => s.scopes);
  const floating = useStore((s) => s.floating);
  const layerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Bounds>({ w: 0, h: 0 });
  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bounds = useCallback(
    () => ({ w: layerRef.current?.clientWidth ?? 0, h: layerRef.current?.clientHeight ?? 0 }),
    [],
  );
  // A panel floated without a rect is placed at its cascade slot as soon as
  // the layer has a size, and the rect is stored, so it never slides when
  // the window resizes or other panels come and go.
  useEffect(() => {
    if (size.w <= 0 || size.h <= 0) return;
    for (const f of floating) {
      if (f.rect === null) useStore.getState().setFloatRect(f.id, defaultFloatRect(f.slot, size));
    }
  }, [floating, size]);
  return (
    <div ref={layerRef} className="scope-float-layer">
      {floating.map((f) => {
        const scope = scopes.find((x) => x.id === f.id);
        // A removed scope's entry lingers harmlessly (undo can bring the
        // scope back, still floating) and draws nothing meanwhile.
        if (!scope) return null;
        return (
          <FloatingScope
            key={f.id}
            engine={engine}
            scope={scope}
            title={scopeDisplayName(scopes, scope)}
            rect={f.rect ? clampFloatRect(f.rect, size) : defaultFloatRect(f.slot, size)}
            z={f.z}
            dock={dock}
            bounds={bounds}
          />
        );
      })}
    </div>
  );
}
