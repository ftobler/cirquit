import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { DEFAULT_SETTINGS } from '../../model/types';

describe('transistor model line parsing', () => {
  it('resolves the 32 model table into the transistor element params', () => {
    // The bundled early.txt shape: the `t` line names the model and the `32`
    // line carries its table (TransistorModel.undump, TransistorModel.java:
    // 227-248): `32 <escaped name> <flags> <satCur> <invRollOffF> <BEleakCur>
    // <leakBEemissionCoeff> <invRollOffR> <BCleakCur> <leakBCemissionCoeff>
    // <emissionCoeffF> <emissionCoeffR> <invEarlyVoltF> <invEarlyVoltR>
    // <betaR>`. Only satCur and betaR are modelled by the port's Ebers-Moll;
    // the rest (early voltage, high-current roll-off, junction leakage) stay
    // on the line but are not resolved into params.
    const text = [
      't 496 256 560 256 0 1 -3.1354863883836575 0.6928898087953951 100 early',
      '32 early 0 1e-13 0 0 1.5 0 0 2 1 1 0.02 0 1',
    ].join('\n');
    const parsed = parseCircuit(text);
    const [e] = parsed.elements;
    expect(e.modelName).toBe('early');
    // beta comes from the element line's own token, untouched by the model.
    expect(e.params.beta).toBe(100);
    expect(e.params.saturationCurrent).toBe(1e-13);
    expect(e.params.betaReverse).toBe(1);
    expect(parsed.unsupported).not.toContain('32');
  });

  it('a 32 line above the naming element resolves too (second pass)', () => {
    // The model library line can sit anywhere; the resolution runs after the
    // whole file is read, exactly like the `34` diode lines. early.txt puts
    // the `32` before its naming `t`.
    const text = [
      '32 early 0 1e-13 0 0 1.5 0 0 2 1 1 0.02 0 1',
      't 496 256 560 256 0 1 -3.1354863883836575 0.6928898087953951 100 early',
    ].join('\n');
    const [e] = parseCircuit(text).elements;
    expect(e.modelName).toBe('early');
    expect(e.params.saturationCurrent).toBe(1e-13);
    expect(e.params.betaReverse).toBe(1);
  });

  it('round-trips the 32 line byte-for-byte in its original position', () => {
    // The early.txt lines: a `default`-model transistor, the `32` library
    // line, then the `early`-model transistor. The `$` line is rebuilt from
    // numbers, so include the header to make the whole file a true
    // byte-for-byte round trip.
    const text = [
      '$ 1 0.000005 10.20027730826997 50 5 50 5e-11',
      't 224 256 288 256 0 1 -3.945779492504472 0.6928898088437567 100 default',
      '32 early 0 1e-13 0 0 1.5 0 0 2 1 1 0.02 0 1',
      't 496 256 560 256 0 1 -3.1354863883836575 0.6928898087953951 100 early',
    ].join('\n');
    const parsed = parseCircuit(text);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toBe(text + '\n');
  });

  it('a model name without a 32 line falls back to the element defaults', () => {
    // Upstream never dumps a `32` line for a built-in model, and an unknown
    // name falls back via getModelWithNameOrCopy (TransistorModel.java:
    // 99-112). The engine's own defaults (sat 1e-13, betaR 1) are what an
    // unresolved element keeps, so nothing is written into params.
    const [e] = parseCircuit(
      't 496 256 560 256 0 1 -3.1354863883836575 0.6928898087953951 100 early',
    ).elements;
    expect(e.modelName).toBe('early');
    expect(e.params.beta).toBe(100);
    expect(e.params.saturationCurrent).toBeUndefined();
    expect(e.params.betaReverse).toBeUndefined();
  });

  it('escaped model names resolve across both lines', () => {
    // The name uses the CustomLogicModel escape set (`\q` is `=`), so both
    // lines must unescape to the same key for the lookup to hit.
    const text = [
      't 100 100 200 100 0 1 0 0 100 beta\\q2',
      '32 beta\\q2 0 1e-13 0 0 1.5 0 0 2 1 1 0.02 0 1',
    ].join('\n');
    const [e] = parseCircuit(text).elements;
    expect(e.modelName).toBe('beta=2');
    expect(e.params.saturationCurrent).toBe(1e-13);
    expect(e.params.betaReverse).toBe(1);
  });

  it('a 32 line does not consume a scope index', () => {
    const text = [
      'r 0 0 16 0 0 100',
      '32 someModel 0 1e-13 0 0 1.5 0 0 2 1 1 0.02 0 1',
      'r 16 0 32 0 0 220',
      'o 1 64 0 4099 20 0.05 0 1',
    ].join('\n');
    const parsed = parseCircuit(text);
    expect(parsed.scopes[0].plots[0].elementIndex).toBe(1);
    expect(parsed.scopes[0].plots[0].elementId).toBe(parsed.elements[1].id);
    expect(parsed.unsupported).not.toContain('32');
  });

  it('a truncated 32 line is preserved but not resolvable', () => {
    // A hand-edited line that stops early must not throw, and must not
    // resolve: without the full table a lookup would write undefined params.
    const text = ['t 100 100 200 100 0 1 0 0 100 bad', '32 bad 0 1e-13'].join('\n');
    const parsed = parseCircuit(text);
    const [e] = parsed.elements;
    expect(e.params.saturationCurrent).toBeUndefined();
    expect(e.params.betaReverse).toBeUndefined();
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toContain('\n32 bad 0 1e-13\n');
  });

  it('a non-positive saturation current is not a resolvable model', () => {
    // A satCur <= 0 would make the junction equation degenerate, so such a
    // line is preserved but the element stays on its defaults.
    const text = [
      't 100 100 200 100 0 1 0 0 100 bad',
      '32 bad 0 0 0 1.5 0 0 2 1 1 0.02 0 1',
    ].join('\n');
    const [e] = parseCircuit(text).elements;
    expect(e.params.saturationCurrent).toBeUndefined();
    expect(e.params.betaReverse).toBeUndefined();
  });
});
