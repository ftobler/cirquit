import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPE_VIEW,
  MAX_VIEW_ZOOM,
  MIN_VIEW_ZOOM,
  clampView,
  cursorReadout,
  isPanned,
  panByPixels,
  viewFor,
  viewRightTime,
  viewSpeed,
  visibleColumns,
  zoomAboutCursor,
  resetScopeView,
  setScopeView,
} from './view';

describe('paused scope view', () => {
  it('clamps zoom and keeps the window inside the captured history', () => {
    expect(clampView({ zoom: 100, offsetColumns: 0 }, 1000, 500).zoom).toBe(MAX_VIEW_ZOOM);
    expect(clampView({ zoom: 0.0001, offsetColumns: 0 }, 1000, 500).zoom).toBe(MIN_VIEW_ZOOM);
    // At zoom 1 a 500 px canvas shows 500 of 1000 columns, so at most 500 back.
    expect(clampView({ zoom: 1, offsetColumns: 900 }, 1000, 500).offsetColumns).toBe(500);
    expect(clampView({ zoom: 1, offsetColumns: -20 }, 1000, 500).offsetColumns).toBe(0);
    expect(clampView({ zoom: NaN, offsetColumns: NaN }, 1000, 500)).toEqual(DEFAULT_SCOPE_VIEW);
  });

  it('never pans back further than the capture allows', () => {
    // Zoomed in, fewer columns back are reachable.
    expect(clampView({ zoom: 4, offsetColumns: 5000 }, 1000, 400).offsetColumns).toBe(900);
    // A capture narrower than the canvas has nothing to pan to.
    expect(clampView({ zoom: 1, offsetColumns: 100 }, 100, 500).offsetColumns).toBe(0);
  });

  it('counts the visible columns from the zoom', () => {
    expect(visibleColumns({ zoom: 1 }, 500)).toBe(500);
    expect(visibleColumns({ zoom: 2 }, 500)).toBe(250);
    expect(visibleColumns({ zoom: 0.5 }, 500)).toBe(500);
    expect(visibleColumns({ zoom: 1 }, 0)).toBe(0);
  });

  it('pans with the content following the pointer', () => {
    // Dragging right reveals older columns.
    expect(panByPixels(DEFAULT_SCOPE_VIEW, 20, 500, 2000).offsetColumns).toBe(20);
    // Two pixels per column pans one column per two pixels.
    expect(panByPixels({ zoom: 2, offsetColumns: 0 }, 20, 500, 2000).offsetColumns).toBe(10);
    // Dragging left cannot go past the live edge.
    expect(panByPixels({ zoom: 1, offsetColumns: 5 }, -20, 500, 2000).offsetColumns).toBe(0);
  });

  it('keeps the column under the cursor fixed while zooming', () => {
    const before = { zoom: 1, offsetColumns: 0 };
    // Cursor at the right edge: the newest column stays there.
    expect(zoomAboutCursor(before, 2, 500, 500, 5000)).toEqual({ zoom: 2, offsetColumns: 0 });
    // Cursor at the centre, zoom 1 -> 2: the same column is 250 back before,
    // so the right edge moves 250 columns back to keep it at the centre.
    const zoomed = zoomAboutCursor(before, 2, 250, 500, 5000);
    expect(zoomed.zoom).toBe(2);
    // The cursor's column was 250 back; at zoom 2 it is 125 columns from the
    // right edge, so the right edge moves 125 columns back.
    expect(zoomed.offsetColumns).toBe(125);
    const distance = (v: { zoom: number; offsetColumns: number }) =>
      v.offsetColumns + 250 / v.zoom;
    expect(distance(zoomed)).toBeCloseTo(distance(before), 9);
  });

  it('maps the view back to time', () => {
    expect(viewRightTime(10, DEFAULT_SCOPE_VIEW, 64, 1e-5)).toBe(10);
    // 100 columns back at 64 steps/column and 1e-5 s/step is 0.064 s.
    expect(viewRightTime(10, { zoom: 1, offsetColumns: 100 }, 64, 1e-5)).toBeCloseTo(
      10 - 100 * 64 * 1e-5,
      12,
    );
    expect(viewSpeed({ zoom: 2, offsetColumns: 0 }, 64)).toBe(32);
  });

  it('remembers a panned view per scope and forgets the live one', () => {
    resetScopeView(9);
    setScopeView(9, { zoom: 2, offsetColumns: 10 });
    expect(viewFor(9)).toEqual({ zoom: 2, offsetColumns: 10 });
    setScopeView(9, DEFAULT_SCOPE_VIEW);
    expect(viewFor(9)).toEqual(DEFAULT_SCOPE_VIEW);
    setScopeView(9, { zoom: 2, offsetColumns: 10 });
    resetScopeView(9);
    expect(viewFor(9)).toEqual(DEFAULT_SCOPE_VIEW);
    expect(isPanned(DEFAULT_SCOPE_VIEW)).toBe(false);
    expect(isPanned({ zoom: 1, offsetColumns: 1 })).toBe(true);
  });
});

describe('cursor readout', () => {
  it('reports dt, its frequency and the value difference', () => {
    expect(cursorReadout(1, 1.25, 2, 5)).toEqual({ dt: 0.25, hz: 4, dv: 3 });
    // Order of the two cursors does not matter for the magnitudes.
    expect(cursorReadout(1.25, 1, 5, 2)).toEqual({ dt: 0.25, hz: 4, dv: -3 });
  });

  it('omits a frequency at zero span and a difference with no sample', () => {
    expect(cursorReadout(2, 2, 1, 1)).toEqual({ dt: 0, hz: null, dv: 0 });
    expect(cursorReadout(1, 2, null, 4)).toEqual({ dt: 1, hz: 1, dv: null });
  });
});
