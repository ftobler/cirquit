/**
 * The scope properties dialog, reproducing ScopePropertiesDialog's capability
 * set: vertical scale mode, per-plot channel coupling and position, the
 * horizontal speed slider, trigger controls, measurement toggles and the
 * label. The form may differ from upstream's GWT grid, but each control maps
 * to a store field the other stages defined.
 */

import { useEffect, useState } from 'react';
import type { PlotMeasurementKey, ScopeValue } from '../engine/simulator';
import { anyPlotOverrides, effectiveMeasurements, plotOverridesScope, sharedPlotElement } from '../engine/simulator';
import { seedManScale, barToSpeed, speedToBar, gridStepX, scaleStateFor, nextHighestScale, nextLowestScale } from '../scope/scale';
import { formatValue, makeTheme } from '../render/draw';
import { MAN_DIVISIONS, trailSliderToSteps, trailStepsToSlider, UNIT, plotColors, visiblePlotsOf } from '../scope/draw';
import { plotValueRows, plotAxisLabel, isVceIcRow } from './scopePlotRows';
import { saveScopeDefaults } from '../state/scopeDefaults';
import { useStore } from '../state/store';
import { useFocusTrap } from './useFocusTrap';
import { stackTabs } from './scopeTabs';

interface Props {
  scopeId: number;
  onClose: () => void;
}

type FlagKey = Parameters<ReturnType<typeof useStore.getState>['setScopeFlags']>[1];

/** The nine per-trace readout rows, in their per-plot-token bit order (the
 *  same list the o-line codec packs). Extended Info, Spectrum, Log Spectrum
 *  and X-Y stay scope-level: they are not per-trace value readouts. */
const MEASUREMENT_ROWS: { label: string; key: PlotMeasurementKey }[] = [
  { label: 'Scale', key: 'showScale' },
  { label: 'Max', key: 'showMax' },
  { label: 'Min', key: 'showMin' },
  { label: 'P-P', key: 'showP2P' },
  { label: 'Freq', key: 'showFreq' },
  { label: 'RMS', key: 'showRMS' },
  { label: 'Average', key: 'showAverage' },
  { label: 'Duty Cycle', key: 'showDutyCycle' },
  { label: 'Show Phase Angle', key: 'showPhaseAngle' },
];

export function ScopeProperties({ scopeId, onClose }: Props) {
  const scope = useStore((s) => s.scopes.find((x) => x.id === scopeId));
  const scopes = useStore((s) => s.scopes);
  const timeStep = useStore((s) => s.settings.timeStep);
  const dark = useStore((s) => s.dark);
  const [labelText, setLabelText] = useState(scope?.label ?? '');
  const [levelText, setLevelText] = useState(String(scope?.trigger.level ?? 0));
  // The channel selector's chosen trace, by id so a re-render survives plot
  // list changes; the derived `selected` falls back to the first visible one.
  const [selectedPlotId, setSelectedPlotId] = useState<number | null>(null);
  // The Measurements fieldset's target: every trace (the scope word) or just
  // the channel the selector has picked. A fresh scope starts on; a reopened
  // dialog seeds from the scope itself, so while any trace overrides it
  // starts off and the boxes keep editing the selected channel instead of
  // lying about their target.
  const [applyToAll, setApplyToAll] = useState(
    () => scope !== undefined && anyPlotOverrides(scope),
  );
  // Modal focus handling like the Dialog shell: Trap Tab, return focus to the
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

  if (!scope) return null;

  const tabs = stackTabs(scopes, scopeId);

  // The channel selector lists the same plots the canvas draws, so each
  // button's dot matches the trace colour; `selected` is the one being edited.
  const visibleChannels = visiblePlotsOf(scope);
  const theme = makeTheme(dark);
  const traceColors = plotColors(scope, theme);
  const selected =
    visibleChannels.find((p) => p.id === selectedPlotId) ?? visibleChannels[0] ?? null;

  const setFlags = (patch: Parameters<ReturnType<typeof useStore.getState>['setScopeFlags']>[1]) =>
    useStore.getState().setScopeFlags(scope.id, patch);

  const scaleMode = scope.manualScale ? 'manual' : scope.maxScale ? 'maxScale' : 'auto';
  const setScaleMode = (mode: 'auto' | 'maxScale' | 'manual') => {
    if (mode === 'manual') {
      // Seed any plot without a user-set scale, like upstream's
      // setManualScale(true, true) (Scope.java:172-183).
      for (const plot of scope.plots) {
        if (plot.manScale === null) {
          const gridMax = scaleStateFor(scope.id, plot.value).gridMax;
          useStore.getState().setPlotManScale(
            plot.id,
            seedManScale(gridMax, scope.manDivisions || MAN_DIVISIONS),
          );
        }
      }
      setFlags({ manualScale: true, maxScale: false });
    } else {
      setFlags({ manualScale: false, maxScale: mode === 'maxScale' });
    }
  };

  const setSpeedBar = (bar: number) => useStore.getState().setScopeSpeed(scope.id, barToSpeed(bar));

  // Trail persistence is stored in sim timesteps; the slider maps logarithmically
  // (trailSliderToSteps/trailStepsToSlider, ScopePropertiesDialog.java:763-776).
  const setTrailBar = (bar: number) => setFlags({ trailPersistence: trailSliderToSteps(bar) });

  const setManScaleText = (plotId: number, text: string) => {
    const v = Number(text);
    if (Number.isFinite(v) && v > 0) useStore.getState().setPlotManScale(plotId, v);
  };

  const setDivisions = (text: string) => {
    const n = Math.round(Number(text));
    if (Number.isFinite(n) && n > 0 && n !== scope.manDivisions) {
      useStore.getState().setScopeFlags(scope.id, { manDivisions: n });
    }
  };

  const applyTriggerLevel = () => {
    const v = Number(levelText);
    if (Number.isFinite(v)) useStore.getState().setScopeTrigger(scope.id, { level: v });
  };

  const toggle = (key: keyof FlagKey, value: boolean | number) =>
    setFlags({ [key]: value } as FlagKey);

  const rows = (label: string, value: boolean, key: keyof FlagKey) => (
    <label key={key}>
      <input type="checkbox" checked={value} onChange={(e) => toggle(key, e.target.checked)} />
      {label}
    </label>
  );

  // One per-trace readout checkbox. With "Apply to all traces" on it writes
  // the scope word every plot inherits; off, it writes the selected channel's
  // own mask through setPlotMeasurementFlag.
  const measurementRow = ({ label, key }: { label: string; key: PlotMeasurementKey }) => {
    const perChannel = visibleChannels.length > 1 && !applyToAll && selected !== null;
    const checked =
      perChannel && selected ? effectiveMeasurements(scope, selected)[key] : scope[key];
    return (
      <label key={key}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) =>
            perChannel && selected
              ? useStore.getState().setPlotMeasurementFlag(selected.id, key, e.target.checked)
              : toggle(key, e.target.checked)
          }
        />
        {label}
      </label>
    );
  };

  // The scope's shared element, present only when every plot names the same
  // one and its kind is known: which extra Plots boxes the dialog offers
  // (upstream gates those rows on all plots sharing one element,
  // Scope.java:1239-1246, so a mixed scope is offered none).
  const singleElement = sharedPlotElement(scope.plots);
  const element = singleElement === null ? null : useStore.getState().elements.find((e) => e.id === singleElement)?.kind ?? null;
  // Upstream's Show Vce vs Ic checked state (isShowingVceAndIc, Scope.java:
  // 1258-1260): the 2D plot on and exactly the VCE/IC pair showing.
  const showingVceIc =
    scope.plotXY &&
    scope.plots.length === 2 &&
    scope.plots[0].value === 'vce' &&
    scope.plots[1].value === 'ic';

  // The Plots boxes mirror upstream's ScopeCheckBox states
  // (ScopePropertiesDialog.java:801-833): checked when the show flag is on and
  // a matching plot exists. Toggling on with none present adds one. A value
  // with a flag (voltage/current) routes through setScopeShowValue; any other
  // value has no flag and toggles the plot itself, upstream's showPlotValue
  // (Scope.java:145-165), via togglePlot.
  const showBox = (label: string, value: ScopeValue, disabled = false) => {
    // A null-element plot is preserved via its raw line only and can never be
    // toggled away, so the checked state follows what togglePlot would remove
    // (elementId !== null), keeping the box and the panel in step.
    const hasPlot = scope.plots.some((p) => p.value === value && p.elementId !== null);
    if (value === 'voltage' || value === 'current') {
      const show = value === 'voltage' ? scope.showV : scope.showI;
      return (
        <label key={value}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={show && hasPlot}
            onChange={(e) => useStore.getState().setScopeShowValue(scope.id, value, e.target.checked)}
          />
          {label}
        </label>
      );
    }
    return (
      <label key={value}>
        <input
          type="checkbox"
          disabled={disabled}
          checked={hasPlot}
          onChange={() => useStore.getState().togglePlot(scope.id, value)}
        />
        {label}
      </label>
    );
  };

  /** The manual-scale stepper for one plot: up steps to the next 1-2-5-10
   *  checkpoint, down to the previous one (ScopePropertiesDialog.java:115-166). */
  const stepManScale = (plotId: number, dir: 1 | -1) => {
    const plot = scope.plots.find((p) => p.id === plotId);
    if (!plot) return;
    // The draw's fallback when no user scale is set; manual-mode entry seeds
    // every plot, so this only covers a loaded manual-mode line.
    const current = plot.manScale ?? seedManScale(5, scope.manDivisions || MAN_DIVISIONS);
    const next = dir > 0 ? nextHighestScale(current) : nextLowestScale(current);
    if (next > 0 && next !== current) useStore.getState().setPlotManScale(plotId, next);
  };

  const unitOf = (value: ScopeValue | null): string => (value === null ? '?' : UNIT[value]);

  // Element kind behind a plot, for the X-Y axis list's `name (units)` labels.
  const kindOfElement = (elementId: number | null): string | null =>
    elementId === null
      ? null
      : (useStore.getState().elements.find((e) => e.id === elementId)?.kind ?? null);

  type XYKey = 'plotX' | 'plotY' | 'plotBrightness' | 'plotColorR' | 'plotColorG' | 'plotColorB';

  /** One X-Y settings list: the axis or modulator selects write their plot
   *  index straight through setScopeFlags; modulator lists prepend None (-1),
   *  axis lists do not (populatePlotListBox, ScopePropertiesDialog.java:
   *  731-741). */
  const xySelect = (label: string, inputId: string, key: XYKey, value: number, withNone: boolean) => (
    <>
      <label htmlFor={inputId}>{label}</label>
      <select
        id={inputId}
        value={value}
        onChange={(e) => toggle(key, Number(e.target.value))}
      >
        {withNone && (
          <option key="none" value={-1}>
            None
          </option>
        )}
        {scope.plots.map((p, i) => (
          <option key={p.id} value={i}>
            {plotAxisLabel(kindOfElement(p.elementId), p.value)}
          </option>
        ))}
      </select>
    </>
  );

  const channelLetter = (value: ScopeValue | null) =>
    value === 'voltage'
      ? 'V'
      : value === 'current'
        ? 'I'
        : value === 'power'
          ? 'P'
          : value === 'charge'
            ? 'Q'
            : value === 'resistance'
              ? 'R'
              : value !== null
                ? value.charAt(0).toUpperCase() + value.slice(1)
                : '?';

  return (
    <div className="scope-props" role="dialog" aria-modal="true" aria-label="Scope properties" tabIndex={-1} ref={panelRef}>
      <h3>Scope Properties</h3>

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
              onClick={() => useStore.getState().openScopeProperties(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      <fieldset>
        <legend>Vertical Scale</legend>
        <div className="row">
          <label>
            <input type="radio" name="scale" checked={scaleMode === 'auto'} onChange={() => setScaleMode('auto')} />
            Auto
          </label>
          <label>
            <input
              type="radio"
              name="scale"
              checked={scaleMode === 'maxScale'}
              onChange={() => setScaleMode('maxScale')}
            />
            Auto (Max Scale)
          </label>
          <label>
            <input
              type="radio"
              name="scale"
              checked={scaleMode === 'manual'}
              onChange={() => setScaleMode('manual')}
            />
            Manual
          </label>
        </div>
        <div className="row">
          <label htmlFor="divisions">Divisions</label>
          <input
            id="divisions"
            className="scalebox scalebox-narrow"
            type="text"
            value={String(scope.manDivisions)}
            onChange={(e) => setDivisions(e.target.value)}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Channels</legend>
        {/* The per-trace selector: one button per trace, marked with its
          colour, so a combined scope's dialog can be pointed at any one of
          them. A single-trace scope skips the strip and edits directly. */}
        {visibleChannels.length > 1 && (
          <div className="row scope-channels" role="group" aria-label="Select a channel">
            {visibleChannels.map((plot, i) => (
              <button
                key={plot.id}
                type="button"
                className={plot.id === selected?.id ? 'scope-channel current' : 'scope-channel'}
                onClick={() => setSelectedPlotId(plot.id)}
              >
                <span
                  className="channel-dot"
                  style={{ background: traceColors.get(plot.id) ?? theme.whiteColor }}
                />
                {`CH ${i + 1} (${channelLetter(plot.value)})`}
                {/* A trace carrying its own measurement readouts gets a small
                  second dot in its colour, so a combined scope shows at a
                  glance which chips hold overrides. */}
                {plotOverridesScope(scope, plot) && (
                  <span
                    className="channel-badge"
                    title="This trace has its own measurements"
                    style={{ background: traceColors.get(plot.id) ?? theme.whiteColor }}
                  />
                )}
              </button>
            ))}
          </div>
        )}
        {selected && (
          <div className="scope-props-channel">
            <div className="row">
              <span>Coupling</span>
              <label>
                <input
                  type="radio"
                  name="channel-coupling"
                  checked={!selected.acCoupled}
                  onChange={() => useStore.getState().setPlotCoupling(scope.id, selected.id, false)}
                />
                DC
              </label>
              <label>
                <input
                  type="radio"
                  name="channel-coupling"
                  disabled={selected.value !== 'voltage'}
                  checked={selected.acCoupled}
                  onChange={() => useStore.getState().setPlotCoupling(scope.id, selected.id, true)}
                />
                AC
              </label>
            </div>
            {scope.manualScale && (
              <>
                <div className="row">
                  <span>{`Max Value (${unitOf(selected.value)})`}</span>
                  <button
                    type="button"
                    aria-label="Decrease max value"
                    onClick={() => stepManScale(selected.id, -1)}
                  >
                    &#9660;
                  </button>
                  <input
                    key={selected.id}
                    className="scalebox"
                    type="text"
                    aria-label="Max value per division"
                    defaultValue={selected.manScale?.toString() ?? ''}
                    onBlur={(e) => setManScaleText(selected.id, e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label="Increase max value"
                    onClick={() => stepManScale(selected.id, 1)}
                  >
                    &#9650;
                  </button>
                  <span>/div</span>
                </div>
                <div className="row">
                  <span>Position</span>
                  <input
                    type="range"
                    min={-200}
                    max={200}
                    value={selected.manVPosition}
                    onChange={(e) =>
                      useStore.getState().setPlotManPosition(selected.id, Number(e.target.value))
                    }
                  />
                  <span>{selected.manVPosition}</span>
                  <button
                    type="button"
                    onClick={() => useStore.getState().setPlotManPosition(selected.id, 0)}
                  >
                    Reset
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Horizontal Scale</legend>
        <div className="row">
          <input
            type="range"
            aria-label="Horizontal scale"
            min={0}
            max={10}
            value={speedToBar(scope.speed)}
            onChange={(e) => setSpeedBar(Number(e.target.value))}
          />
          <span>{formatValue(gridStepX(scope.speed, useStore.getState().settings.timeStep), 's')}/div</span>
        </div>
      </fieldset>

      <fieldset>
        <legend>Trigger</legend>
        <div className="row">
          {(['freeRun', 'normal', 'auto'] as const).map((m) => (
            <label key={m}>
              <input
                type="radio"
                name="trigmode"
                checked={scope.trigger.mode === m}
                onChange={() => useStore.getState().setScopeTrigger(scope.id, { mode: m })}
              />
              {m === 'freeRun' ? 'Free Run' : m === 'normal' ? 'Normal' : 'Auto'}
            </label>
          ))}
        </div>
        <div className="row">
          <span>Edge</span>
          {(['rising', 'falling'] as const).map((e) => (
            <label key={e}>
              <input
                type="radio"
                name="trigedge"
                checked={scope.trigger.edge === e}
                onChange={() => useStore.getState().setScopeTrigger(scope.id, { edge: e })}
              />
              {e === 'rising' ? 'Rising' : 'Falling'}
            </label>
          ))}
          <span>Level</span>
          <input
            className="scalebox"
            type="text"
            aria-label="Trigger level"
            value={levelText}
            onChange={(e) => setLevelText(e.target.value)}
          />
          <button type="button" onClick={applyTriggerLevel}>
            Apply
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Measurements</legend>
        {/* The per-trace readouts follow the channel selector: all traces
            together (the scope word, today's behaviour) or just the picked
            channel. Switching back to all traces clears every plot's mask so
            no stale override hides behind the boxes. A single-trace scope
            skips the toggle and always edits the scope word. */}
        {visibleChannels.length > 1 && (
          <div className="row">
            <label>
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(e) => {
                  setApplyToAll(e.target.checked);
                  if (e.target.checked) {
                    useStore.getState().clearPlotMeasurementOverrides(scope.id);
                  }
                }}
              />
              Apply to all traces
            </label>
          </div>
        )}
        <div className="row row-wrap">
          {/* The per-element Plots boxes, upstream's order (a transistor's six
              pin plots in place of Show Voltage/Current, then power, charge
              for a capacitor, resistance enabled only for a lamp and the
              compound Vce-vs-Ic action). */}
          {plotValueRows(element).map((row) =>
            isVceIcRow(row) ? (
              // Upstream's box reads isShowingVceAndIc() (Scope.java:1258-1260)
              // and its command re-seeds the pair whenever fired; unchecking
              // here just leaves the 2D mode.
              <label key="vce-ic">
                <input
                  type="checkbox"
                  checked={showingVceIc}
                  onChange={(e) =>
                    e.target.checked
                      ? useStore.getState().setScopeVceIc(scope.id)
                      : setFlags({ plotXY: false })
                  }
                />
                {row.label}
              </label>
            ) : (
              showBox(row.label, row.value, row.disabled)
            ),
          )}
          {MEASUREMENT_ROWS.map(measurementRow)}
          {rows('Extended Info', scope.showElmInfo, 'showElmInfo')}
          {rows('Spectrum', scope.fftPlot, 'fftPlot')}
          {rows('Log Spectrum', scope.logSpectrum, 'logSpectrum')}
          {rows('X-Y', scope.plotXY, 'plotXY')}
        </div>
      </fieldset>

      <fieldset>
        <legend>X-Y Plots</legend>
        <div className="row">
          <label htmlFor="trail">Trail Persistence (time steps)</label>
          <input
            id="trail"
            type="range"
            min={0}
            max={61}
            value={trailStepsToSlider(scope.trailPersistence)}
            onChange={(e) => setTrailBar(Number(e.target.value))}
          />
          <span>
            {scope.trailPersistence <= 0
              ? 'default'
              : formatValue(scope.trailPersistence * timeStep, 's')}
          </span>
        </div>
        {scope.plotXY && (
          <>
            <div className="row row-wrap">
              {/* Upstream's X-Y settings grid: an X Axis and Y Axis list over
                  the scope's plots, then Brightness and the R/G/B colour
                  modulators, each -1 for none
                  (ScopePropertiesDialog.java:494-533, 655-668). */}
              {xySelect('X Axis', 'xy-x', 'plotX', scope.plotX, false)}
              {xySelect('Y Axis', 'xy-y', 'plotY', scope.plotY, false)}
              {xySelect('Brightness', 'xy-brightness', 'plotBrightness', scope.plotBrightness, true)}
              {xySelect('Red', 'xy-r', 'plotColorR', scope.plotColorR, true)}
              {xySelect('Green', 'xy-g', 'plotColorG', scope.plotColorG, true)}
              {xySelect('Blue', 'xy-b', 'plotColorB', scope.plotColorB, true)}
            </div>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Label</legend>
        <input
          className="scalebox scalebox-wide"
          type="text"
          aria-label="Scope label"
          value={labelText}
          onChange={(e) => setLabelText(e.target.value)}
          onBlur={() => setFlags({ label: labelText })}
        />
      </fieldset>

      <div className="scope-props-actions">
        <button type="button" onClick={() => saveScopeDefaults(scope)}>
          Save as Default
        </button>
        <button
          type="button"
          title="Put this scope's display settings, speed and trigger back to the default"
          onClick={() => useStore.getState().resetScopeToDefaults(scope.id)}
        >
          Reset to Default
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
