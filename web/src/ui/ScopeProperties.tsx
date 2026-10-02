/**
 * The scope properties dialog. It covers ScopePropertiesDialog's capability
 * set (vertical scale mode, per-plot coupling, manual scale and position,
 * the time base, the trigger, the measurement readouts, the X-Y settings and
 * the label), regrouped into sections behind a rail so each screen holds the
 * controls used together, with every channel's settings in its own row
 * instead of behind a channel picker. The header drags the dialog off the
 * trace it is editing. The data side (rows, parsing, targets) lives in
 * scopePropsModel.ts; this file lays it out and wires the store actions.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PlotMeasurementKey, Scope, ScopePlot, ScopeValue } from '../engine/scopeModel';
import { effectiveMeasurements, sharedPlotElement } from '../engine/scopeModel';
import {
  barToSpeed,
  clearScaleStates,
  gridStepX,
  nextHighestScale,
  nextLowestScale,
  scaleStateFor,
  seedManScale,
  speedToBar,
} from '../scope/scale';
import { formatValue, makeTheme } from '../render/draw';
import { formatUnitsAscii } from '../model/units';
import {
  MAN_DIVISIONS,
  UNIT,
  plotColors,
  trailSliderToSteps,
  trailStepsToSlider,
  visiblePlotsOf,
} from '../scope/draw';
import { defFor } from '../model/registry';
import { isVceIcRow, plotAxisLabel, plotValueRows } from './scopePlotRows';
import { saveScopeDefaults } from '../state/scopeDefaults';
import { useStore } from '../state/store';
import { useFocusTrap } from './useFocusTrap';
import { stackTabs } from './scopeTabs';
import {
  SCOPE_PROPS_SECTIONS,
  channelRows,
  clampDialogOffset,
  effectiveReadoutTarget,
  initialReadoutTarget,
  nextEnabledIndex,
  parseDivisions,
  parseManScale,
  parseValue,
  scopeDisplayName,
  shouldCommit,
  type ChannelRow,
  type ReadoutTarget,
  type ScopePropsSection,
} from './scopePropsModel';

interface Props {
  scopeId: number;
  onClose: () => void;
}

type FlagPatch = Parameters<ReturnType<typeof useStore.getState>['setScopeFlags']>[1];

/** The nine per-trace readouts, in their per-plot-token bit order (the same
 *  list the o-line codec packs). */
const READOUTS: { label: string; key: PlotMeasurementKey }[] = [
  { label: 'Scale', key: 'showScale' },
  { label: 'Max', key: 'showMax' },
  { label: 'Min', key: 'showMin' },
  { label: 'Peak-peak', key: 'showP2P' },
  { label: 'Frequency', key: 'showFreq' },
  { label: 'RMS', key: 'showRMS' },
  { label: 'Average', key: 'showAverage' },
  { label: 'Duty cycle', key: 'showDutyCycle' },
  { label: 'Phase angle', key: 'showPhaseAngle' },
];

// The dialog remembers where it was and which section was open for the rest
// of the session: switching stack tabs remounts it, and reopening it for the
// next scope should not throw it back to the centre and the first section.
let lastSection: ScopePropsSection = 'traces';
let lastOffset = { x: 0, y: 0 };

// ─── Small controls ───

/** A connected button group choosing one of a few values, MD3's segmented
 *  button: a radio group for assistive tech, a row of toggles on screen. */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  reselect = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  /** Fire onChange for a click on the option already chosen too, for a
   *  choice that also acts (All traces clears leftover overrides). */
  reselect?: boolean;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const off = options.map((o) => disabled || o.disabled === true);
  const chosen = options.findIndex((o) => o.value === value);
  // One Tab stop per group, the WAI radio pattern: the chosen option, or the
  // first enabled one when the chosen is disabled or absent.
  const stop = chosen >= 0 && !off[chosen] ? chosen : off.indexOf(false);
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const next = nextEnabledIndex(off, i, dir);
    if (next === i) return;
    onChange(options[next].value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };
  return (
    <div ref={groupRef} className="sp-segmented" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'selected' : undefined}
          title={o.title}
          disabled={off[i]}
          tabIndex={i === stop ? 0 : -1}
          onKeyDown={(e) => onKeyDown(e, i)}
          onClick={() => (reselect || o.value !== value) && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** An on/off filter chip: one readout, one plot, one display mode. */
function Chip({
  checked,
  onChange,
  disabled = false,
  title,
  children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={checked ? 'sp-chip on' : 'sp-chip'}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
    >
      {children}
    </button>
  );
}

/**
 * A text field that commits on Enter or blur, never per keystroke, so typing
 * "1.5m" is one undo entry rather than three half-typed values. An entry the
 * parser refuses is marked invalid and puts the stored value back on blur.
 */
function ValueField({
  value,
  parse,
  onCommit,
  label,
  className,
  placeholder,
  disabled = false,
}: {
  value: string;
  parse: (text: string) => unknown;
  onCommit: (text: string) => void;
  label: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // An outside change (undo, a stepper, a stack tab) refreshes the box, but
  // never under the user's cursor.
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const invalid = draft !== value && parse(draft) === null;
  const commit = () => {
    if (shouldCommit(draft, value, parse)) onCommit(draft);
  };
  return (
    <input
      type="text"
      className={className ? `sp-field ${className}` : 'sp-field'}
      aria-label={label}
      aria-invalid={invalid}
      placeholder={placeholder}
      disabled={disabled}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      onBlur={() => {
        commit();
        setFocused(false);
        if (parse(draft) === null) setDraft(value);
      }}
    />
  );
}

/** A labelled line of controls inside a section. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sp-row">
      <span className="sp-row-label">{label}</span>
      <div className="sp-row-controls">{children}</div>
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return <span className="channel-dot" style={{ background: color }} />;
}

// ─── The dialog ───

export function ScopeProperties({ scopeId, onClose }: Props) {
  const scope = useStore((s) => s.scopes.find((x) => x.id === scopeId));
  const scopes = useStore((s) => s.scopes);
  const elements = useStore((s) => s.elements);
  const settings = useStore((s) => s.settings);
  const dark = useStore((s) => s.dark);
  const floating = useStore((s) => s.floating.some((f) => f.id === scopeId));
  const [section, setSection] = useState<ScopePropsSection>(lastSection);
  const [offset, setOffset] = useState(lastOffset);
  const [readoutTarget, setReadoutTarget] = useState<ReadoutTarget>(() =>
    scope ? initialReadoutTarget(scope, visiblePlotsOf(scope)) : 'all',
  );
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    start: { x: number; y: number };
    rect: { left: number; top: number; width: number };
  } | null>(null);
  // Modal focus handling like the Dialog shell: trap Tab, return focus to the
  // opener on close. The opener (a scope-menu row) is usually gone by then,
  // so the trap's restore guards against a detached element.
  const panelRef = useFocusTrap<HTMLDivElement>({ returnFocus: true });

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The remembered offset was clamped against the window it was dragged in;
  // a window shrunk since could leave the header off screen with no way to
  // grab it back. Re-clamp on open and on every resize.
  useEffect(() => {
    const reclamp = () => {
      const r = panelRef.current?.getBoundingClientRect();
      if (!r) return;
      setOffset((current) => {
        const next = clampDialogOffset(
          current,
          { left: r.left, top: r.top, width: r.width },
          0,
          0,
          { w: window.innerWidth, h: window.innerHeight },
        );
        if (next.x === current.x && next.y === current.y) return current;
        lastOffset = next;
        return next;
      });
    };
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [panelRef]);

  if (!scope) return null;

  const st = useStore.getState();
  const tabs = stackTabs(scopes, scopeId);
  const visible = visiblePlotsOf(scope);
  const theme = makeTheme(dark, settings);
  const colors = plotColors(scope, theme);
  const labelOf = (elementId: number | null): string | null => {
    if (elementId === null) return null;
    const kind = elements.find((e) => e.id === elementId)?.kind;
    return kind === undefined ? null : (defFor(kind)?.label ?? kind);
  };
  const channels = channelRows(scope, visible, labelOf, (id) => colors.get(id), theme.whiteColor);
  const sources = [...new Set(channels.map((c) => c.source))].join(', ');

  const chooseSection = (id: ScopePropsSection) => {
    lastSection = id;
    setSection(id);
  };

  // ─── Header drag ───
  const onHeaderDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    const r = panelRef.current?.getBoundingClientRect();
    if (!r) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      start: offset,
      rect: { left: r.left, top: r.top, width: r.width },
    };
  };
  const onHeaderMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const next = clampDialogOffset(d.start, d.rect, e.clientX - d.x, e.clientY - d.y, {
      w: window.innerWidth,
      h: window.innerHeight,
    });
    lastOffset = next;
    setOffset(next);
  };
  const onHeaderUp = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="scope-props"
      role="dialog"
      aria-modal="true"
      aria-label={`Scope properties: ${scopeDisplayName(scopes, scope)}`}
      tabIndex={-1}
      ref={panelRef}
      style={{
        transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
      }}
    >
      <header
        className="sp-header"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        onPointerCancel={onHeaderUp}
        onLostPointerCapture={onHeaderUp}
        onDoubleClick={(e) => {
          // A double-click on a header button is two clicks on it, not a
          // request to re-centre.
          if (e.target instanceof Element && e.target.closest('button')) return;
          lastOffset = { x: 0, y: 0 };
          setOffset(lastOffset);
        }}
        title="Drag to move, double-click to centre"
      >
        <div className="sp-title">
          <h3>{scopeDisplayName(scopes, scope)}</h3>
          <span className="sp-subtitle">{sources || 'Scope properties'}</span>
        </div>
        <button
          type="button"
          className="sp-icon"
          title={floating ? 'Dock this scope' : 'Float this scope over the schematic'}
          aria-label={floating ? 'Dock scope' : 'Float scope'}
          onClick={() => (floating ? st.dockScope(scope.id) : st.floatScope(scope.id))}
        >
          {floating ? '⤓' : '⧉'}
        </button>
        <button type="button" className="sp-icon" title="Close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      {/* Stacked scopes share a column, so each canvas is a sliver and its
        settings wheel is nearly unhittable. With the dialog open, every scope
        stacked with this one is one tab away. Absent entirely when the scope
        has its column to itself. */}
      {tabs.length > 0 && (
        <div className="scope-tabs" role="tablist" aria-label="Scopes in this stack">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.current}
              className={tab.current ? 'scope-tab current' : 'scope-tab'}
              onClick={() => st.openScopeProperties(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      <div className="sp-body">
        <nav className="sp-rail" role="tablist" aria-orientation="vertical" aria-label="Sections">
          {SCOPE_PROPS_SECTIONS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              id={`sp-tab-${s.id}`}
              aria-selected={s.id === section}
              aria-controls="sp-pane"
              tabIndex={s.id === section ? 0 : -1}
              className={s.id === section ? 'current' : undefined}
              onClick={() => chooseSection(s.id)}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
                if (step === 0) return;
                e.preventDefault();
                const n = SCOPE_PROPS_SECTIONS.length;
                const next = SCOPE_PROPS_SECTIONS[(i + step + n) % n].id;
                chooseSection(next);
                document.getElementById(`sp-tab-${next}`)?.focus();
              }}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="sp-pane" id="sp-pane" role="tabpanel" aria-labelledby={`sp-tab-${section}`}>
          {section === 'traces' && (
            <TracesSection scope={scope} scopes={scopes} channels={channels} />
          )}
          {section === 'vertical' && <VerticalSection scope={scope} channels={channels} />}
          {section === 'timebase' && <TimebaseSection scope={scope} timeStep={settings.timeStep} />}
          {section === 'readouts' && (
            <ReadoutsSection
              scope={scope}
              channels={channels}
              target={effectiveReadoutTarget(readoutTarget, visible)}
              onTarget={setReadoutTarget}
            />
          )}
          {section === 'display' && (
            <DisplaySection scope={scope} timeStep={settings.timeStep} />
          )}
        </div>
      </div>

      <footer className="sp-actions">
        <button
          type="button"
          title="Seed every new scope with this one's display settings, speed and trigger level"
          onClick={() => saveScopeDefaults(scope)}
        >
          Save as default
        </button>
        <button
          type="button"
          title="Put this scope's display settings, speed and trigger back to the default"
          onClick={() => st.resetScopeToDefaults(scope.id)}
        >
          Reset to default
        </button>
        <button
          type="button"
          title="Clear the captured trace and the sticky auto-scale"
          onClick={() => {
            // The sticky scales are per (scope, units family): wiping the
            // scope's whole entry covers every trace, like the menu's Reset.
            clearScaleStates([scope.id]);
            st.resetScope(scope.id);
          }}
        >
          Clear trace
        </button>
        <span className="sp-spacer" />
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </div>
  );
}

// ─── Sections ───

function TracesSection({
  scope,
  scopes,
  channels,
}: {
  scope: Scope;
  scopes: Scope[];
  channels: ChannelRow[];
}) {
  const st = useStore.getState();
  // The scope's shared element, present only when every plot names the same
  // one: which extra plot chips the section offers (upstream gates those rows
  // on all plots sharing one element, Scope.java:1239-1246, so a mixed scope
  // is offered none).
  const shared = sharedPlotElement(scope.plots);
  const kind =
    shared === null ? null : (st.elements.find((e) => e.id === shared)?.kind ?? null);
  // Upstream's Show Vce vs Ic checked state (isShowingVceAndIc, Scope.java:
  // 1258-1260): the 2D plot on and exactly the VCE/IC pair showing.
  const showingVceIc =
    scope.plotXY &&
    scope.plots.length === 2 &&
    scope.plots[0].value === 'vce' &&
    scope.plots[1].value === 'ic';
  // The plot chips mirror upstream's ScopeCheckBox states (ScopePropertiesDialog
  // .java:801-833): on when the show flag is on and a matching plot exists.
  // Voltage and current route through their show flags; any other value
  // toggles the plot itself (Scope.java:145-165). A raw-only plot can never be
  // toggled away, so only resolved plots count.
  const plotChip = (label: string, value: ScopeValue, disabled: boolean) => {
    const hasPlot = scope.plots.some((p) => p.value === value && p.elementId !== null);
    const flagged = value === 'voltage' ? scope.showV : value === 'current' ? scope.showI : true;
    return (
      <Chip
        key={value}
        checked={flagged && hasPlot}
        disabled={disabled}
        onChange={(on) =>
          value === 'voltage' || value === 'current'
            ? st.setScopeShowValue(scope.id, value, on)
            : st.togglePlot(scope.id, value)
        }
      >
        {label}
      </Chip>
    );
  };
  return (
    <>
      <Row label="Label">
        <ValueField
          className="sp-field-wide"
          label="Scope label"
          placeholder={`Scope ${scopes.indexOf(scope) + 1}`}
          value={scope.label}
          parse={(t) => t}
          onCommit={(t) => st.setScopeFlags(scope.id, { label: t.trim() })}
        />
      </Row>
      <div className="sp-subhead">Channels</div>
      <div className="sp-channels">
        {channels.map((c) => (
          <div key={c.plot.id} className="sp-channel">
            <Dot color={c.color} />
            <span className="sp-channel-name">
              {c.name} <span className="sp-muted">{c.letter}</span>
            </span>
            <span className="sp-channel-source" title={c.source}>
              {c.source}
            </span>
            <Segmented
              label={`${c.name} coupling`}
              value={c.plot.acCoupled ? 'ac' : 'dc'}
              options={[
                { value: 'dc', label: 'DC' },
                {
                  value: 'ac',
                  label: 'AC',
                  disabled: !c.acAllowed,
                  title: c.acAllowed ? 'Block the DC part' : 'AC coupling applies to voltage only',
                },
              ]}
              onChange={(v) => st.setPlotCoupling(scope.id, c.plot.id, v === 'ac')}
            />
            <button
              type="button"
              className="sp-icon"
              aria-label={`Remove ${c.name}`}
              title={c.removable ? 'Remove this trace' : 'The last trace cannot be removed'}
              disabled={!c.removable}
              onClick={() => st.removePlot(scope.id, c.plot.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="sp-subhead">Plots</div>
      <div className="sp-chips">
        {plotValueRows(kind).map((row) =>
          isVceIcRow(row) ? (
            // Upstream's command re-seeds the pair whenever fired; switching
            // it off just leaves the 2D mode.
            <Chip
              key="vce-ic"
              checked={showingVceIc}
              onChange={(on) =>
                on ? st.setScopeVceIc(scope.id) : st.setScopeFlags(scope.id, { plotXY: false })
              }
            >
              {row.label}
            </Chip>
          ) : (
            plotChip(row.label, row.value, row.disabled)
          ),
        )}
      </div>
    </>
  );
}

function VerticalSection({ scope, channels }: { scope: Scope; channels: ChannelRow[] }) {
  const st = useStore.getState();
  const divisions = scope.manDivisions || MAN_DIVISIONS;
  const mode = scope.manualScale ? 'manual' : scope.maxScale ? 'max' : 'auto';
  const setMode = (m: 'auto' | 'max' | 'manual') => {
    if (m === 'manual') {
      // Seed any plot without a user-set scale, like upstream's
      // setManualScale(true, true) (Scope.java:172-183).
      for (const plot of scope.plots) {
        if (plot.manScale === null) {
          const gridMax = scaleStateFor(scope.id, plot.value).gridMax;
          st.setPlotManScale(plot.id, seedManScale(gridMax, divisions));
        }
      }
      st.setScopeFlags(scope.id, { manualScale: true, maxScale: false });
    } else {
      st.setScopeFlags(scope.id, { manualScale: false, maxScale: m === 'max' });
    }
  };
  /** Up steps to the next 1-2-5-10 checkpoint, down to the previous one
   *  (ScopePropertiesDialog.java:115-166). */
  const step = (plot: ScopePlot, dir: 1 | -1) => {
    const current = plot.manScale ?? seedManScale(5, divisions);
    const next = dir > 0 ? nextHighestScale(current) : nextLowestScale(current);
    if (next > 0 && next !== current) st.setPlotManScale(plot.id, next);
  };
  return (
    <>
      <Row label="Scale">
        <Segmented
          label="Vertical scale"
          value={mode}
          options={[
            { value: 'auto', label: 'Auto', title: 'Fit the visible trace' },
            { value: 'max', label: 'Hold max', title: 'Fit the largest value seen so far' },
            { value: 'manual', label: 'Manual', title: 'Set units per division per channel' },
          ]}
          onChange={setMode}
        />
      </Row>
      <Row label="Divisions">
        <ValueField
          className="sp-field-narrow"
          label="Divisions"
          value={String(scope.manDivisions)}
          parse={parseDivisions}
          disabled={!scope.manualScale}
          onCommit={(t) => {
            const n = parseDivisions(t);
            if (n !== null) st.setScopeFlags(scope.id, { manDivisions: n });
          }}
        />
      </Row>
      {scope.manualScale ? (
        <div className="sp-channels">
          {channels.map((c) => (
            <div key={c.plot.id} className="sp-channel sp-channel-scale">
              <Dot color={c.color} />
              <span className="sp-channel-name">{c.name}</span>
              <div className="sp-stepper">
                <button
                  type="button"
                  aria-label={`Decrease ${c.name} scale`}
                  onClick={() => step(c.plot, -1)}
                >
                  −
                </button>
                <ValueField
                  className="sp-field-narrow"
                  label={`${c.name} units per division`}
                  value={c.plot.manScale === null ? '' : formatUnitsAscii(c.plot.manScale)}
                  parse={parseManScale}
                  onCommit={(t) => {
                    const v = parseManScale(t);
                    if (v !== null) st.setPlotManScale(c.plot.id, v);
                  }}
                />
                <button
                  type="button"
                  aria-label={`Increase ${c.name} scale`}
                  onClick={() => step(c.plot, 1)}
                >
                  +
                </button>
              </div>
              <span className="sp-muted">{c.unit}/div</span>
              <input
                type="range"
                className="sp-position"
                aria-label={`${c.name} position`}
                title="Vertical position"
                min={-200}
                max={200}
                value={c.plot.manVPosition}
                onChange={(e) => st.setPlotManPosition(c.plot.id, Number(e.target.value))}
              />
              <button
                type="button"
                className="sp-icon"
                aria-label={`Centre ${c.name}`}
                title="Centre"
                disabled={c.plot.manVPosition === 0}
                onClick={() => st.setPlotManPosition(c.plot.id, 0)}
              >
                ⟲
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="sp-hint">
          Switch to Manual to set each channel's units per division and position. In manual mode
          a trace can also be dragged up and down on the scope.
        </p>
      )}
    </>
  );
}

function TimebaseSection({ scope, timeStep }: { scope: Scope; timeStep: number }) {
  const st = useStore.getState();
  const bar = speedToBar(scope.speed);
  const setBar = (b: number) => st.setScopeSpeed(scope.id, barToSpeed(Math.max(0, Math.min(10, b))));
  const triggered = scope.trigger.mode !== 'freeRun';
  // The level is in the first drawn channel's unit, the trace the trigger
  // watches.
  const firstValue = visiblePlotsOf(scope)[0]?.value ?? 'voltage';
  return (
    <>
      <Row label="Time/div">
        <div className="sp-slider">
          <button type="button" aria-label="Faster time base" disabled={bar <= 0} onClick={() => setBar(bar - 1)}>
            −
          </button>
          <input
            type="range"
            aria-label="Time per division"
            min={0}
            max={10}
            value={bar}
            onChange={(e) => setBar(Number(e.target.value))}
          />
          <button type="button" aria-label="Slower time base" disabled={bar >= 10} onClick={() => setBar(bar + 1)}>
            +
          </button>
          <span className="sp-readout">{formatValue(gridStepX(scope.speed, timeStep), 's')}</span>
        </div>
      </Row>
      <div className="sp-subhead">Trigger</div>
      <Row label="Mode">
        <Segmented
          label="Trigger mode"
          value={scope.trigger.mode}
          options={[
            { value: 'freeRun', label: 'Free run', title: 'No trigger: the trace scrolls' },
            { value: 'normal', label: 'Normal', title: 'Draw only on a trigger' },
            { value: 'auto', label: 'Auto', title: 'Trigger, or free run when none comes' },
          ]}
          onChange={(mode) => st.setScopeTrigger(scope.id, { mode })}
        />
      </Row>
      <Row label="Edge">
        <Segmented
          label="Trigger edge"
          value={scope.trigger.edge}
          disabled={!triggered}
          options={[
            { value: 'rising', label: '↗ Rising' },
            { value: 'falling', label: '↘ Falling' },
          ]}
          onChange={(edge) => st.setScopeTrigger(scope.id, { edge })}
        />
      </Row>
      <Row label="Level">
        <ValueField
          className="sp-field-narrow"
          label="Trigger level"
          disabled={!triggered}
          value={formatUnitsAscii(scope.trigger.level)}
          parse={parseValue}
          onCommit={(t) => {
            const v = parseValue(t);
            if (v !== null) st.setScopeTrigger(scope.id, { level: v });
          }}
        />
        <span className="sp-muted">{firstValue === null ? '' : UNIT[firstValue]}</span>
      </Row>
    </>
  );
}

function ReadoutsSection({
  scope,
  channels,
  target,
  onTarget,
}: {
  scope: Scope;
  channels: ChannelRow[];
  target: ReadoutTarget;
  onTarget: (t: ReadoutTarget) => void;
}) {
  const st = useStore.getState();
  const channel = target === 'all' ? null : (channels.find((c) => c.plot.id === target) ?? null);
  const isOn = (key: PlotMeasurementKey) =>
    channel ? effectiveMeasurements(scope, channel.plot)[key] : scope[key];
  const set = (key: PlotMeasurementKey, on: boolean) =>
    channel
      ? st.setPlotMeasurementFlag(channel.plot.id, key, on)
      : st.setScopeFlags(scope.id, { [key]: on } as FlagPatch);
  return (
    <>
      {channels.length > 1 && (
        <Row label="Apply to">
          <Segmented<ReadoutTarget>
            reselect
            label="Readouts apply to"
            value={target}
            options={[
              {
                value: 'all',
                label: 'All traces',
                title: 'Every trace shows the same readouts; clears per-channel choices',
              },
              ...channels.map((c) => ({
                value: c.plot.id as ReadoutTarget,
                label: (
                  <>
                    <Dot color={c.color} />
                    {c.name}
                    {c.overrides && <span className="sp-badge" title="Has its own readouts" />}
                  </>
                ),
              })),
            ]}
            onChange={(t) => {
              // Back to all traces drops every channel's own mask, so no
              // stale override hides behind the shared chips.
              if (t === 'all') st.clearPlotMeasurementOverrides(scope.id);
              onTarget(t);
            }}
          />
        </Row>
      )}
      <div className="sp-chips">
        {READOUTS.map(({ label, key }) => (
          <Chip key={key} checked={isOn(key)} onChange={(on) => set(key, on)}>
            {label}
          </Chip>
        ))}
      </div>
      <p className="sp-hint">
        {channel
          ? `${channel.name} shows its own readouts; the other traces keep theirs.`
          : 'Readouts are drawn under the trace they measure.'}
      </p>
    </>
  );
}

type XYKey = 'plotX' | 'plotY' | 'plotBrightness' | 'plotColorR' | 'plotColorG' | 'plotColorB';

function DisplaySection({ scope, timeStep }: { scope: Scope; timeStep: number }) {
  const st = useStore.getState();
  const flag = (patch: FlagPatch) => st.setScopeFlags(scope.id, patch);
  const kindOf = (elementId: number | null) =>
    elementId === null ? null : (st.elements.find((e) => e.id === elementId)?.kind ?? null);
  /** One X-Y list: the axis lists have no None, the modulators do (-1)
   *  (populatePlotListBox, ScopePropertiesDialog.java:731-741). */
  const xySelect = (label: string, key: XYKey, withNone: boolean) => (
    <label className="sp-select" key={key}>
      <span>{label}</span>
      <select value={scope[key]} onChange={(e) => flag({ [key]: Number(e.target.value) } as FlagPatch)}>
        {withNone && <option value={-1}>None</option>}
        {scope.plots.map((p, i) => (
          <option key={p.id} value={i}>
            {plotAxisLabel(kindOf(p.elementId), p.value)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <div className="sp-chips">
        <Chip checked={scope.showElmInfo} onChange={(on) => flag({ showElmInfo: on })}>
          Element info
        </Chip>
        <Chip checked={scope.fftPlot} onChange={(on) => flag({ fftPlot: on })}>
          Spectrum
        </Chip>
        <Chip
          checked={scope.logSpectrum}
          disabled={!scope.fftPlot}
          title={scope.fftPlot ? undefined : 'Turn on Spectrum first'}
          onChange={(on) => flag({ logSpectrum: on })}
        >
          Log spectrum
        </Chip>
        <Chip checked={scope.plotXY} onChange={(on) => flag({ plotXY: on })}>
          X-Y plot
        </Chip>
      </div>
      {scope.plotXY && (
        <>
          <div className="sp-subhead">X-Y plot</div>
          {/* Upstream's X-Y settings grid: the axes, then brightness and the
              R/G/B colour modulators (ScopePropertiesDialog.java:494-533). */}
          <div className="sp-xy">
            {xySelect('X axis', 'plotX', false)}
            {xySelect('Y axis', 'plotY', false)}
            {xySelect('Brightness', 'plotBrightness', true)}
            {xySelect('Red', 'plotColorR', true)}
            {xySelect('Green', 'plotColorG', true)}
            {xySelect('Blue', 'plotColorB', true)}
          </div>
          <Row label="Trail">
            <div className="sp-slider">
              {/* Stored in sim timesteps, mapped logarithmically (ScopeProperties
                  Dialog.java:763-776). */}
              <input
                type="range"
                aria-label="Trail persistence"
                min={0}
                max={61}
                value={trailStepsToSlider(scope.trailPersistence)}
                onChange={(e) => flag({ trailPersistence: trailSliderToSteps(Number(e.target.value)) })}
              />
              <span className="sp-readout">
                {scope.trailPersistence <= 0
                  ? 'default'
                  : formatValue(scope.trailPersistence * timeStep, 's')}
              </span>
            </div>
          </Row>
        </>
      )}
    </>
  );
}
