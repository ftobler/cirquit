/**
 * The scope properties dialog, reproducing ScopePropertiesDialog's capability
 * set: vertical scale mode, per-plot channel coupling and position, the
 * horizontal speed slider, trigger controls, measurement toggles and the
 * label. The form may differ from upstream's GWT grid, but each control maps
 * to a store field the other stages defined.
 */

import { useEffect, useState } from 'react';
import { seedManScale, barToSpeed, speedToBar, gridStepX, scaleStateFor } from '../scope/scale';
import { formatValue } from '../render/draw';
import { MAN_DIVISIONS } from '../scope/draw';
import { useStore } from '../state/store';
import { useFocusTrap } from './useFocusTrap';

interface Props {
  scopeId: number;
  onClose: () => void;
}

type FlagKey = Parameters<ReturnType<typeof useStore.getState>['setScopeFlags']>[1];

export function ScopeProperties({ scopeId, onClose }: Props) {
  const scope = useStore((s) => s.scopes.find((x) => x.id === scopeId));
  const [labelText, setLabelText] = useState(scope?.label ?? '');
  const [levelText, setLevelText] = useState(String(scope?.trigger.level ?? 0));
  const [divisions, setDivisions] = useState(String(MAN_DIVISIONS));
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
          useStore.getState().setPlotManScale(plot.id, seedManScale(gridMax, Number(divisions) || MAN_DIVISIONS));
        }
      }
      setFlags({ manualScale: true, maxScale: false });
    } else {
      setFlags({ manualScale: false, maxScale: mode === 'maxScale' });
    }
  };

  const setSpeedBar = (bar: number) => useStore.getState().setScopeSpeed(scope.id, barToSpeed(bar));

  const setManScaleText = (plotId: number, text: string) => {
    const v = Number(text);
    if (Number.isFinite(v) && v > 0) useStore.getState().setPlotManScale(plotId, v);
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

  return (
    <div className="scope-props" role="dialog" aria-modal="true" aria-label="Scope properties" tabIndex={-1} ref={panelRef}>
      <h3>Scope Properties</h3>

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
            className="scalebox"
            type="text"
            value={divisions}
            onChange={(e) => setDivisions(e.target.value)}
            style={{ width: 48 }}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Channels</legend>
        {scope.plots.map((plot) => (
          <div key={plot.id} className="scope-props-channel">
            <div className="row">
              <span>{`CH ${plot.value === 'voltage' ? 'V' : plot.value === 'current' ? 'I' : 'P'}`}</span>
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
                <input
                  className="scalebox"
                  type="text"
                  aria-label="Scale per division"
                  defaultValue={plot.manScale?.toString() ?? ''}
                  onBlur={(e) => setManScaleText(plot.id, e.target.value)}
                  style={{ width: 64 }}
                />
                <span>/div</span>
                <input
                  type="range"
                  min={-100}
                  max={100}
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
            style={{ width: 64 }}
          />
          <button type="button" onClick={applyTriggerLevel}>
            Apply
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Measurements</legend>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {rows('Scale', scope.showScale, 'showScale')}
          {rows('Max', scope.showMax, 'showMax')}
          {rows('Min', scope.showMin, 'showMin')}
          {rows('P-P', scope.showP2P, 'showP2P')}
          {rows('Freq', scope.showFreq, 'showFreq')}
          {rows('RMS', scope.showRMS, 'showRMS')}
          {rows('Average', scope.showAverage, 'showAverage')}
          {rows('Duty Cycle', scope.showDutyCycle, 'showDutyCycle')}
          {rows('Spectrum', scope.fftPlot, 'fftPlot')}
          {rows('Log Spectrum', scope.logSpectrum, 'logSpectrum')}
          {rows('X-Y', scope.plotXY, 'plotXY')}
        </div>
      </fieldset>

      <fieldset>
        <legend>Label</legend>
        <input
          className="scalebox"
          type="text"
          aria-label="Scope label"
          value={labelText}
          onChange={(e) => setLabelText(e.target.value)}
          onBlur={() => setFlags({ label: labelText })}
          style={{ width: '100%' }}
        />
      </fieldset>

      <div className="scope-props-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
