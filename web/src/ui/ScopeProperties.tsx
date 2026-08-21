/**
 * The scope properties dialog, reproducing ScopePropertiesDialog's capability
 * set: vertical scale mode, per-plot channel coupling and position, the
 * horizontal speed slider, trigger controls, measurement toggles and the
 * label. The form may differ from upstream's GWT grid, but each control maps
 * to a store field the other stages defined.
 */

import { useEffect, useState } from 'react';
import type { ScopeValue } from '../engine/simulator';
import { seedManScale, barToSpeed, speedToBar, gridStepX, scaleStateFor, nextHighestScale, nextLowestScale } from '../scope/scale';
import { formatValue } from '../render/draw';
import { MAN_DIVISIONS, trailSliderToSteps, trailStepsToSlider, UNIT } from '../scope/draw';
import { saveScopeDefaults } from '../state/scopeDefaults';
import { useStore } from '../state/store';
import { useFocusTrap } from './useFocusTrap';
import { stackTabs } from './scopeTabs';

interface Props {
  scopeId: number;
  onClose: () => void;
}

type FlagKey = Parameters<ReturnType<typeof useStore.getState>['setScopeFlags']>[1];

export function ScopeProperties({ scopeId, onClose }: Props) {
  const scope = useStore((s) => s.scopes.find((x) => x.id === scopeId));
  const scopes = useStore((s) => s.scopes);
  const timeStep = useStore((s) => s.settings.timeStep);
  const [labelText, setLabelText] = useState(scope?.label ?? '');
  const [levelText, setLevelText] = useState(String(scope?.trigger.level ?? 0));
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

  const setFlags = (patch: Parameters<ReturnType<typeof useStore.getState>['setScopeFlags']>[1]) =>
    useStore.getState().setScopeFlags(scope.id, patch);

  const scaleMode = scope.manualScale ? 'manual' : scope.maxScale ? 'maxScale' : 'auto';
  const setScaleMode = (mode: 'auto' | 'maxScale' | 'manual') => {
    if (mode === 'manual') {
      // Seed any plot without a user-set scale, like upstream's
      // setManualScale(true, true) (Scope.java:172-183).
      for (const plot of scope.plots) {
        if (plot.manScale === null) {
          const gridMax = scaleStateFor(plot.id).gridMax;
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

  const toggle = (key: keyof FlagKey, value: boolean) => setFlags({ [key]: value } as FlagKey);

  const rows = (label: string, value: boolean, key: keyof FlagKey) => (
    <label key={key}>
      <input type="checkbox" checked={value} onChange={(e) => toggle(key, e.target.checked)} />
      {label}
    </label>
  );

  // The scope's single element, when there is exactly one and its kind is
  // known: which extra Plots boxes the dialog offers (ScopePropertiesDialog
  // shows Show Charge only for a capacitor, ScopePropertiesDialog.java:573-576).
  const singleElement = scope.plots.find((p) => p.elementId !== null)?.elementId ?? null;
  const element = singleElement === null ? null : useStore.getState().elements.find((e) => e.id === singleElement)?.kind ?? null;
  const isCapacitor = element === 'capacitor' || element === 'polarizedCapacitor';

  // The Plots boxes mirror upstream's ScopeCheckBox states
  // (ScopePropertiesDialog.java:801-804): checked when the show flag is on and
  // a matching plot exists. Toggling on with none present adds one. A value
  // with a flag (voltage/current) routes through setScopeShowValue; any other
  // value (power, charge) has no flag and toggles the plot itself, upstream's
  // showPower/showPlotValue (Scope.java:145-165), via togglePlot.
  const showBox = (label: string, value: ScopeValue) => {
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

  const channelLetter = (value: ScopeValue | null) =>
    value === 'voltage' ? 'V' : value === 'current' ? 'I' : value === 'power' ? 'P' : value === 'charge' ? 'Q' : '?';

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
        {scope.plots.map((plot) => (
          <div key={plot.id} className="scope-props-channel">
            <div className="row">
              <span>{`CH ${channelLetter(plot.value)}`}</span>
              <label>
                <input
                  type="radio"
                  name={`coupling-${plot.id}`}
                  checked={!plot.acCoupled}
                  onChange={() => useStore.getState().setPlotCoupling(scope.id, plot.id, false)}
                />
                DC
              </label>
              <label>
                <input
                  type="radio"
                  name={`coupling-${plot.id}`}
                  disabled={plot.value !== 'voltage'}
                  checked={plot.acCoupled}
                  onChange={() => useStore.getState().setPlotCoupling(scope.id, plot.id, true)}
                />
                AC
              </label>
            </div>
            {scope.manualScale && (
              <div className="row">
                <span>{`Max Value (${unitOf(plot.value)})`}</span>
                <button type="button" aria-label="Decrease max value" onClick={() => stepManScale(plot.id, -1)}>
                  &#9660;
                </button>
                <input
                  className="scalebox"
                  type="text"
                  aria-label="Max value per division"
                  defaultValue={plot.manScale?.toString() ?? ''}
                  onBlur={(e) => setManScaleText(plot.id, e.target.value)}
                />
                <button type="button" aria-label="Increase max value" onClick={() => stepManScale(plot.id, 1)}>
                  &#9650;
                </button>
                <span>/div</span>
              </div>
            )}
            {scope.manualScale && (
              <div className="row">
                <input
                  type="range"
                  min={-200}
                  max={200}
                  value={plot.manVPosition}
                  onChange={(e) =>
                    useStore.getState().setPlotManPosition(plot.id, Number(e.target.value))
                  }
                />
                <span>{plot.manVPosition}</span>
                <button
                  type="button"
                  onClick={() => useStore.getState().setPlotManPosition(plot.id, 0)}
                >
                  Reset
                </button>
              </div>
            )}
          </div>
        ))}
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
        <div className="row row-wrap">
          {showBox('Show Voltage', 'voltage')}
          {showBox('Show Current', 'current')}
          {showBox('Show Power Consumed', 'power')}
          {isCapacitor && showBox('Show Charge', 'charge')}
          {rows('Scale', scope.showScale, 'showScale')}
          {rows('Max', scope.showMax, 'showMax')}
          {rows('Min', scope.showMin, 'showMin')}
          {rows('P-P', scope.showP2P, 'showP2P')}
          {rows('Freq', scope.showFreq, 'showFreq')}
          {rows('RMS', scope.showRMS, 'showRMS')}
          {rows('Average', scope.showAverage, 'showAverage')}
          {rows('Duty Cycle', scope.showDutyCycle, 'showDutyCycle')}
          {rows('Show Phase Angle', scope.showPhaseAngle, 'showPhaseAngle')}
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
