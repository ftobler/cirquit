import { describe, expect, it, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCircuit, serializeCircuit } from './index';
import { makeElement } from '../../state/store';
import { postsOf } from '../../model/registry';
import { DEFAULT_SETTINGS } from '../../model/types';
import type { CustomLogicModel } from './types';
import { clearSessionModels, parseCompositeModelLine, registerSessionModel } from '../subcircuits';
import { CIRCUITS_DIR } from './fixtures';

describe('logic gate file formats', () => {
  /** Parses a single element line and re-emits it, returning that line. */
  const gateLine = (line: string, code: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith(`${code} `)) ?? '' };
  };

  it('a two-input AND gate line round-trips byte-for-byte', () => {
    // inputCount lastOutputVoltage highVoltage, the GateElm token order
    // (GateElm.java:55-61). Numeric tokens normalise like every other element,
    // so 0.0 writes back as 0.
    const line = '150 192 176 336 176 0 2 0 5';
    const { e, elementLine } = gateLine(line, '150');
    expect(e.params.inputCount).toBe(2);
    expect(e.params.lastOutputVoltage).toBe(0);
    expect(e.params.highVoltage).toBe(5);
    expect(elementLine).toBe(line);
  });

  it.each([
    ['nandGate', '151'],
    ['orGate', '152'],
    ['norGate', '153'],
    ['xorGate', '154'],
    ['xnorGate', '431'],
  ])('%s round-trips its line', (_kind, code) => {
    const line = `${code} 192 176 336 176 0 3 2.5 5`;
    const { e, elementLine } = gateLine(line, code);
    expect(e.params.inputCount).toBe(3);
    expect(e.params.lastOutputVoltage).toBe(2.5);
    expect(e.params.highVoltage).toBe(5);
    expect(elementLine).toBe(line);
  });

  it('a gate line without the highVoltage token takes upstream 5', () => {
    const { e, elementLine } = gateLine('150 192 176 336 176 0 2 0.0', '150');
    expect(e.params.highVoltage).toBe(5);
    expect(elementLine).toBe('150 192 176 336 176 0 2 0 5');
  });

  it('a bare gate line loads the two-input defaults', () => {
    const { e, elementLine } = gateLine('150 192 176 336 176 0', '150');
    expect(e.params.inputCount).toBe(2);
    expect(e.params.highVoltage).toBe(5);
    expect(elementLine).toBe('150 192 176 336 176 0 2 0 5');
  });

  it('gate flag bits ride through a save', () => {
    // FLAG_SMALL (1), FLAG_SCHMITT (2) and FLAG_INVERT_INPUTS (4) are format
    // bits (GateElm.java:26-28); flags 6 is schmitt + invert-inputs.
    const { e, elementLine } = gateLine('151 0 0 32 0 6 2 0 5', '151');
    expect(e.flags).toBe(6);
    expect(elementLine).toBe('151 0 0 32 0 6 2 0 5');
  });

  it('gate posts follow the editable input count', () => {
    const two = parseCircuit('150 0 0 96 0 0 2 0 5').elements[0];
    expect(postsOf(two)).toEqual([
      { x: 0, y: 16 },
      { x: 0, y: -16 },
      { x: 96, y: 0 },
    ]);
    const three = parseCircuit('150 0 0 96 0 0 3 0 5').elements[0];
    expect(postsOf(three)).toEqual([
      { x: 0, y: 16 },
      { x: 0, y: 0 },
      { x: 0, y: -16 },
      { x: 96, y: 0 },
    ]);
  });

  it('a fractional gate input count normalises on load to the engine integer', () => {
    // A hand-edited 2.5 would draw 4 posts with `Math.round` but build 3 with
    // the engine's `(2.5 as i64)` truncation, so the spec fails the post-count
    // guard. Parse clamps to the integer the engine derives, the same clamp the
    // controlled sources apply (csParse, vcvs.ts:70).
    const { e, elementLine } = gateLine('150 0 0 96 0 0 2.5 0 5', '150');
    expect(e.params.inputCount).toBe(2);
    expect(elementLine).toBe('150 0 0 96 0 0 2 0 5');
  });

  it('a boundary gate input count clamps to the engine 1..8 range on load', () => {
    const low = gateLine('150 0 0 96 0 0 0.5 0 5', '150');
    expect(low.e.params.inputCount).toBe(1);
    const high = gateLine('150 0 0 96 0 0 9.5 0 5', '150');
    expect(high.e.params.inputCount).toBe(8);
  });

  it('an oversized gate input count warns on load instead of rewriting silently', () => {
    // Clamp-on-load policy (oversized-gates-load-policy, option 2): the engine
    // supports at most 8 inputs, so a hand-edited 12-input gate loads as 8 and
    // the next save would rewrite it; the parse reports the loss through
    // `warnings` so it is surfaced instead of hidden.
    const parsed = parseCircuit('150 0 0 96 0 0 12 0 5\n');
    expect(parsed.elements[0].params.inputCount).toBe(8);
    expect(parsed.warnings).toEqual(['AND gate with 12 inputs loaded as 8 inputs']);
  });

  it('an in-range gate input count loads clean with no warning', () => {
    const parsed = parseCircuit('150 0 0 96 0 0 6 0 5\n');
    expect(parsed.elements[0].params.inputCount).toBe(6);
    expect(parsed.warnings).toEqual([]);
  });

  it('an inverter line round-trips byte-for-byte', () => {
    const line = 'I 272 208 352 208 0 0.5 5';
    const { e, elementLine } = gateLine(line, 'I');
    expect(e.params.slewRate).toBe(0.5);
    expect(e.params.highVoltage).toBe(5);
    expect(elementLine).toBe(line);
  });

  it('a tri-state line round-trips byte-for-byte', () => {
    // r_on r_off r_off_ground highVoltage (TriStateElm.java:52-67). The token
    // constructor's r_off_ground default is 0, which a bare line keeps. The
    // 1e10 off resistance writes as the expanded integer, like every numeric
    // token this port emits.
    const line = '180 0 0 96 0 0 0.1 10000000000 0 5';
    const { e, elementLine } = gateLine(line, '180');
    expect(e.params.r_on).toBe(0.1);
    expect(e.params.r_off).toBe(1e10);
    expect(e.params.r_off_ground).toBe(0);
    expect(e.params.highVoltage).toBe(5);
    expect(elementLine).toBe(line);
  });

  it('a tri-state with a pulldown keeps its r_off_ground token', () => {
    const line = '180 0 0 96 0 0 0.1 10000000000 100000000 5';
    const { e, elementLine } = gateLine(line, '180');
    expect(e.params.r_off_ground).toBe(1e8);
    expect(elementLine).toBe(line);
  });

  it.each([
    ['schmitt', '182'],
    ['invertingSchmitt', '183'],
  ])('%s round-trips its five tokens', (_kind, code) => {
    const line = `${code} 0 0 96 0 0 0.5 1.66 3.33 5 0`;
    const { e, elementLine } = gateLine(line, code);
    expect(e.params.slewRate).toBe(0.5);
    expect(e.params.lowerTrigger).toBe(1.66);
    expect(e.params.upperTrigger).toBe(3.33);
    expect(e.params.logicOnLevel).toBe(5);
    expect(e.params.logicOffLevel).toBe(0);
    expect(elementLine).toBe(line);
  });

  it('a fresh gate dumps the upstream constructor defaults', () => {
    const e = makeElement('andGate', 0, 0, 32, 0);
    expect(e.params.inputCount).toBe(2);
    expect(e.params.highVoltage).toBe(5);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('150 0 0 32 0 0 2 0 5');
  });

  it('a fresh tri-state dumps the token-constructor defaults, not the fresh ones', () => {
    // The fresh constructor's r_off_ground is 1e8 but the token one is 0
    // (TriStateElm.java:44-45, :56), so a save writes what a reload reads.
    const e = makeElement('triState', 0, 0, 32, 0);
    expect(e.params.r_off_ground).toBe(0);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('180 0 0 32 0 0 0.1 10000000000 0 5');
  });
});

describe('logic input file format', () => {
  /** Parses a single `L` line and re-emits it, returning that line. */
  const logicLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('L ')) ?? '';
    return { e, out, elementLine };
  };

  it('an unlabelled line round-trips its two levels', () => {
    const line = 'L 0 0 100 0 0 0 false 5 0';
    const { e, elementLine } = logicLine(line);
    expect(e.params.hiV).toBe(5);
    expect(e.params.loV).toBe(0);
    expect(e.state).toBe(0);
    expect(elementLine).toBe(line);
  });

  it('a label shifts hiV and loV one token along', () => {
    // The label token exists only under FLAG_LABEL and is consumed before the
    // two levels are read (SwitchElm.java:66-67, LogicInputElm.java:38-40), so
    // hiV/loV follow it rather than the switch's position/momentary pair.
    const line = 'L 0 0 100 0 4 1 false A 5 0';
    const { e, elementLine } = logicLine(line);
    expect(e.text).toBe('A');
    expect(e.params.position).toBe(1);
    expect(e.params.hiV).toBe(5);
    expect(e.params.loV).toBe(0);
    expect(elementLine).toBe(line);
  });

  it('a ternary input keeps its third position', () => {
    // FLAG_TERNARY (1) needs no extra token: position 2 is a plain value.
    const line = 'L 0 0 100 0 1 2 false 5 0';
    const { e, elementLine } = logicLine(line);
    expect(e.params.position).toBe(2);
    expect(e.state).toBe(2);
    expect(elementLine).toBe(line);
  });

  it('loads a legacy true position token low', () => {
    // Upstream's shared switch reader inverts the boolean form for this class
    // only (SwitchElm.java:56-62): 'true' means position 0, which doStep
    // drives at loV (LogicInputElm.java:105-110).
    const { e } = logicLine('L 80 240 48 240 0 true false 5 0');
    expect(e.params.position).toBe(0);
    expect(e.state).toBe(0);
  });

  it('loads a legacy false position token high', () => {
    const { e } = logicLine('L 80 240 48 240 0 false false');
    expect(e.params.position).toBe(1);
    expect(e.state).toBe(1);
  });

  it('does not invert numeric position tokens', () => {
    // The numeric branch is the one every SwitchElm subclass shares
    // (SwitchElm.java:62); only the words invert. Both lines are real corpus
    // shapes whose trailing word is the momentary token, not the level.
    const monostable = logicLine('L 80 240 48 240 0 1 true 5 0');  // 555monostable.txt:16
    expect(monostable.e.params.position).toBe(1);
    expect(monostable.elementLine).toBe('L 80 240 48 240 0 1 true 5 0');
    const avr = logicLine('L 304 80 336 80 0 0 false 5 0');  // avr8js-logic.txt:10
    expect(avr.e.params.position).toBe(0);
    expect(avr.elementLine).toBe('L 304 80 336 80 0 0 false 5 0');
  });

  it('keeps a ternary mid position un-inverted in its corpus shape', () => {
    // 3-cgand.txt:46 verbatim: FLAG_TERNARY riding a numeric position, which
    // must reach the numeric branch untouched by the boolean inversion.
    const { e } = logicLine('L 160 192 96 192 1 2 false 5.0 0.0');
    expect(e.params.position).toBe(2);
    expect(e.state).toBe(2);
  });

  it('reads a labelled logic input without shifting levels', () => {
    // The label occupies index 2 under FLAG_LABEL and pushes hiV/loV along;
    // the inverted boolean reading must not move those indices.
    const { e, elementLine } = logicLine('L 80 240 48 240 4 true false clk 5 0');
    expect(e.text).toBe('clk');
    expect(e.params.position).toBe(0);
    expect(e.params.hiV).toBe(5);
    expect(e.params.loV).toBe(0);
    expect(elementLine).toBe('L 80 240 48 240 4 0 false clk 5 0');
  });

  it('reads the momentary word in either spelling independently of the level', () => {
    // dram.txt carries both `true true` and `false true` rows: the second
    // word is the momentary flag, never part of the level.
    const held = logicLine('L 208 360 160 360 0 true true 5.0 0.0').e;  // dram.txt:63
    expect(held.params.position).toBe(0);
    expect(held.params.momentary).toBe(1);
    const released = logicLine('L 208 224 160 224 0 false true 5.0 0.0').e;  // dram.txt:49
    expect(released.params.position).toBe(1);
    expect(released.params.momentary).toBe(1);
  });

  it('a missing position token still lands on 0', () => {
    // Upstream throws and drops the element; the port-wide loader policy keeps
    // it at NaN || 0. That tolerance is unchanged by the inversion.
    const { e } = logicLine('L 80 240 48 240 0');
    expect(e.params.position).toBe(0);
    expect(e.state).toBe(0);
  });

  it('leaves the plain switch boolean mapping alone', () => {
    // Guard against over-reach: without the instanceof LogicInputElm branch
    // the reader maps 'true' to closed and 'false' to open
    // (SwitchElm.java:56-62).
    const position = (line: string) => parseCircuit(line).elements[0].params.position;
    expect(position('s 384 80 448 80 0 true')).toBe(1);
    expect(position('s 384 80 448 80 0 false')).toBe(0);
  });

  it('boots cmosxor.txt low off its true token and normalises the line on save', () => {
    // Corpus guard. cmosxor.txt:18 is `L 144 80 64 80 0 true false`, which
    // upstream boots LOW: position 0 drives loV (SwitchElm.java:56-62,
    // LogicInputElm.java:105-110). Saving writes integer positions, so the
    // boolean spelling normalises to the upstream-correct 0.
    const text = readFileSync(join(CIRCUITS_DIR, 'cmosxor.txt'), 'utf8');
    expect(text.split('\n')[17]).toBe('L 144 80 64 80 0 true false');
    const parsed = parseCircuit(text);
    const statesOf = (c: ReturnType<typeof parseCircuit>) =>
      c.elements.filter((e) => e.kind === 'logicInput').map((e) => e.state);
    expect(statesOf(parsed)).toEqual([0, 0]);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
      parsed.sliders,
    );
    // The writer always emits the two levels after the momentary word
    // (LogicInputElm.java:51-53), so the short corpus line grows its `5 0`
    // tail while the boolean position normalises to the integer 0.
    expect(out.split('\n').filter((l) => l.startsWith('L '))).toEqual([
      'L 144 80 64 80 0 0 false 5 0',
      'L 144 176 64 176 0 0 false 5 0',
    ]);
    // The normalised form is idempotent: same levels, same bytes.
    const again = parseCircuit(out);
    expect(statesOf(again)).toEqual([0, 0]);
    const resaved = serializeCircuit(
      again.elements,
      { ...DEFAULT_SETTINGS, ...again.settings },
      again.scopes,
      again.passthrough,
      again.order,
      again.sliders,
    );
    expect(resaved).toBe(out);
  });

  it('follows the upstream rule for every boolean-position L line in the corpus', () => {
    // The sweep pins the whole affected set: 75 boolean-position lines over 35
    // bundled circuits boot at the level SwitchElm.java:56-62 assigns, not
    // the one the plain-switch reading would give.
    const files = readdirSync(CIRCUITS_DIR).filter(
      (f) => f.endsWith('.txt') && f !== 'setuplist.txt',
    );
    let matches = 0;
    const touched = new Set<string>();
    const anomalies: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(join(CIRCUITS_DIR, file), 'utf8').split('\n')) {
        const m = /^L (\S+ ){5}(true|false)( |$)/.exec(line);
        if (!m) continue;
        matches += 1;
        touched.add(file);
        const [e] = parseCircuit(line).elements;
        // 'true' loads LOW and 'false' HIGH for a LogicInputElm
        // (SwitchElm.java:56-62).
        const want = m[2] === 'true' ? 0 : 1;
        if (e.params.position !== want) anomalies.push(`${file}: ${line}`);
      }
    }
    expect(anomalies).toEqual([]);
    expect(matches).toBeGreaterThanOrEqual(70);
    expect(touched.size).toBeGreaterThanOrEqual(30);
  });
});

describe('analog switch and logic output file formats', () => {
  /** Parses a single element line and re-emits it, returning that line. */
  const elementLine = (line: string, code: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith(`${code} `)) ?? '' };
  };

  it('an analog switch line round-trips byte-for-byte', () => {
    // r_on r_off threshold, with FLAG_PULLDOWN (2) as the fresh constructor
    // sets it (AnalogSwitchElm.java:43).
    const line = '159 0 0 100 0 2 20 10000000000 2.5';
    const { e, elementLine: out } = elementLine(line, '159');
    expect(e.params.r_on).toBe(20);
    expect(e.params.r_off).toBe(1e10);
    expect(e.params.threshold).toBe(2.5);
    expect(e.flags).toBe(2);
    expect(out).toBe(line);
  });

  it('an analog switch 2 line round-trips byte-for-byte', () => {
    const line = '160 0 0 100 0 2 20 10000000000 2.5';
    const { e, elementLine: out } = elementLine(line, '160');
    expect(e.params.r_on).toBe(20);
    expect(e.params.r_off).toBe(1e10);
    expect(e.params.threshold).toBe(2.5);
    expect(out).toBe(line);
  });

  it('a fresh analog switch 2 defaults to the pulldown flag', () => {
    // AnalogSwitch2Elm inherits the SPST's fresh FLAG_PULLDOWN, so the saved
    // line carries bit 2 (AnalogSwitchElm.java:43).
    const e = makeElement('analogSwitch2', 0, 0, 32, 0);
    expect(e.flags).toBe(2);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('160 0 0 32 0 2 20 10000000000 2.5');
  });

  it('a logic output line round-trips byte-for-byte', () => {
    const line = 'M 0 0 100 0 0 2.5';
    const { e, elementLine: out } = elementLine(line, 'M');
    expect(e.params.threshold).toBe(2.5);
    expect(out).toBe(line);
  });
});

describe('custom logic file format', () => {
  const HEADER = '$ 1 0.000005 10 50 5 43 5e-11\n';
  /** The ledarray.txt smiley pair: the `!` model line and its `208` element. */
  const MODEL_LINE =
    '! smiley 0 S2,S1,S0 A,B,C,D,E,F,G,H smiley\\sgenerator ' +
    '000\\q00111100\\n001\\q01000010\\n111\\q00111100\\n';
  const ELEMENT_LINE = '208 528 336 624 336 0 smiley 0 0 5 5 5 5 0 0';

  it('parses a `!` model line and a `208` element into a model and element', () => {
    const parsed = parseCircuit(HEADER + MODEL_LINE + '\n' + ELEMENT_LINE + '\n');
    // The `!` line is not an element: it rides in passthrough, in place.
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.passthrough).toContain(MODEL_LINE);
    const cl = parsed.elements[0];
    expect(cl.kind).toBe('customLogic');
    expect(cl.text).toBe('smiley');
    const model = cl.model as CustomLogicModel;
    expect(model.inputs).toEqual(['S2', 'S1', 'S0']);
    expect(model.outputs).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(model.infoText).toBe('smiley generator');
    expect(model.triState).toBe(false);
    // The rules round-trip their escapes: `\q` is `=`, `\n` a newline, `\s` a
    // space, and parseRules drops the trailing empty line.
    expect(model.rules).toBe('000=00111100\n001=01000010\n111=00111100\n');
    expect(model.rulesLeft).toEqual(['000', '001', '111']);
    expect(model.rulesRight).toEqual(['00111100', '01000010', '00111100']);
    // The saved output voltages land in output order (output 2 reads high).
    expect(cl.params.voltage0).toBe(0);
    expect(cl.params.voltage2).toBe(5);
    // Posts are the 3 inputs plus 8 outputs, the model's pin table.
    expect(postsOf(cl)).toHaveLength(11);
  });

  it('re-emits the `!` line and `208` element byte-for-byte', () => {
    const text = HEADER + MODEL_LINE + '\n' + ELEMENT_LINE + '\n';
    const parsed = parseCircuit(text);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toBe(text);
    const again = parseCircuit(out);
    expect(again.elements[0].model).toEqual(parsed.elements[0].model);
    expect(again.elements[0].params).toEqual(parsed.elements[0].params);
  });

  it('a `208` line whose model name has no `!` line stays on the defaults', () => {
    const parsed = parseCircuit(HEADER + ELEMENT_LINE + '\n');
    const cl = parsed.elements[0];
    expect(cl.text).toBe('smiley');
    expect(cl.model).toBeUndefined();
    // The element keeps its model name and output voltages for the round trip,
    // but draws the fallback 4-input / 2-output body.
    expect(cl.params.voltage0).toBe(0);
    expect(postsOf(cl)).toHaveLength(6);
  });

  it('the same line saves only the fallback output count', () => {
    // The writer emits one voltage per output pin of the resolved-or-fallback
    // pin table, so an unresolvable model writes two tokens where the loaded
    // smiley line carried eight. The name still rides through, so a later
    // load resolves the model once its `!` line exists; the extra voltages
    // stay session-only and die with the element.
    const parsed = parseCircuit(HEADER + ELEMENT_LINE + '\n');
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    const line = out.split('\n').find((l) => l.startsWith('208 ')) ?? '';
    expect(line).toBe('208 528 336 624 336 0 smiley 0 0');
    // And a reload of that shape stays on the fallback body.
    const [again] = parseCircuit(line).elements;
    expect(again.text).toBe('smiley');
    expect(again.params.voltage1).toBe(0);
    expect(again.params.voltage2).toBeUndefined();
    expect(postsOf(again)).toHaveLength(6);
  });

  it('parses the pattern dedup upstream applies to repeated left-side letters', () => {
    // `aa` written as the same letter twice dedups to the save/compare pair
    // (CustomLogicModel.java:231-237): the second `a` becomes `A`, so the
    // rule means "pin 0 equals pin 1".
    const line = '! eq 0 A,B C,D eq ' + 'aa\\q10\\n00\\q00\\n';
    const parsed = parseCircuit(line + '\n208 0 0 96 0 0 eq 0 0\n');
    expect(parsed.passthrough).toContain(line);
    const model = parsed.elements[0].model as CustomLogicModel;
    expect(model.rulesLeft).toEqual(['aA', '00']);
    expect(model.rulesRight).toEqual(['10', '00']);
  });
});

describe('custom composite file format', () => {
  const HEADER = '$ 1 0.000005 10 50 5 43 5e-11\n';
  /** The subcircuit.test.ts divider fixture: `in` on node 1 north, `out` on
   *  node 3 south, two 1k resistors. */
  const MODEL_LINE =
    '. myCirc 0 2 2 2 in 1 0 0 out 3 0 1 ' +
    'ResistorElm\\s1\\s2\\rResistorElm\\s2\\s3 ' +
    '0\\\\s1000\\s0\\\\s1000';
  /** The port's own 410 shape: one escaped model-name token after the flags. */
  const ELEMENT_LINE = '410 0 0 96 0 0 myCirc';

  afterEach(() => clearSessionModels());

  it('parses a `.` line and a 410 element into the engine payload', () => {
    const parsed = parseCircuit(HEADER + MODEL_LINE + '\n' + ELEMENT_LINE + '\n');
    // The `.` line is not an element: it rides in passthrough, in place.
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.passthrough).toContain(MODEL_LINE);
    const el = parsed.elements[0];
    expect(el.kind).toBe('customComposite');
    expect(el.text).toBe('myCirc');
    // The payload shape `Composite::from_spec` parses (composite.rs): the
    // model lines, the external node ids in extList order, the `_`-joined
    // child dumps from the `.` line's elmDump.
    expect(el.model).toEqual({
      model: 'ResistorElm 1 2\rResistorElm 2 3',
      external: [1, 3],
      dumps: ['0_1000', '0_1000'],
    });
  });

  it('re-emits the `.` line and 410 element byte-for-byte', () => {
    const text = HEADER + MODEL_LINE + '\n' + ELEMENT_LINE + '\n';
    const parsed = parseCircuit(text);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toBe(text);
    const again = parseCircuit(out);
    expect(again.elements[0].model).toEqual(parsed.elements[0].model);
    expect(again.elements[0].text).toEqual(parsed.elements[0].text);
  });

  it('draws the resolved model pin table once the load registers it', () => {
    // parseCircuit is pure, so the geometry lookup needs the model registered
    // the way loadNetlist registers a file's `.` lines before any drawing.
    registerSessionModel(parseCompositeModelLine(MODEL_LINE)!);
    const parsed = parseCircuit(HEADER + MODEL_LINE + '\n' + ELEMENT_LINE + '\n');
    const el = parsed.elements[0];
    // The two pins: `in` north and `out` south of the 2x2 body.
    expect(postsOf(el)).toHaveLength(2);
  });

  it('a 410 line with an unresolvable name keeps the name and stays on the fallback', () => {
    const parsed = parseCircuit(HEADER + ELEMENT_LINE + '\n');
    const el = parsed.elements[0];
    expect(el.text).toBe('myCirc');
    expect(el.model).toBeUndefined();
    // The fallback stub body, one west pin on a 1x1 chip.
    expect(postsOf(el)).toHaveLength(1);
  });
});

describe('chip family file formats', () => {
  /** Parses a single element line and re-emits it, returning that line. */
  const chipLine = (line: string, code: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith(`${code} `)) ?? '' };
  };

  it('186 PISO shift register line round-trips', () => {
    // bits, then the packed data word after the common fields. Upstream's own
    // dump() drops the data word, so this port's writer puts it back; the line
    // below is the constructor stream (PisoShiftElm.java:42-47).
    const line = '186 160 320 320 320 2 8 42';
    const { e, elementLine } = chipLine(line, '186');
    expect(e.params.bits).toBe(8);
    expect(e.params.data0).toBe(42);
    expect(e.flags).toBe(2);
    expect(elementLine).toBe(line);
  });

  it('189 SIPO shift register line round-trips', () => {
    const line = '189 160 320 320 320 0 8 85';
    const { e, elementLine } = chipLine(line, '189');
    expect(e.params.bits).toBe(8);
    expect(e.params.data0).toBe(85);
    expect(elementLine).toBe(line);
  });

  it('188 sequence generator line round-trips its bit count and data', () => {
    // The new-format stream: bit count, then the packed words (SeqGenElm.java:
    // 64-69). FLAG_NEW_VERSION and FLAG_HAS_RESET are both set.
    const line = '188 160 320 320 320 10 8 5';
    const { e, elementLine } = chipLine(line, '188');
    expect(e.params.bitCount).toBe(8);
    expect(e.params.data0).toBe(5);
    expect(e.flags).toBe(10);
    expect(elementLine).toBe(line);
  });

  it('188 legacy byte format upgrades to the new layout on load', () => {
    // A pre-2009 file carries one byte and no bit count (SeqGenElm.java:56).
    // Upstream upgrades it to bitCount 8 with FLAG_NEW_VERSION set, and the
    // next save writes the new form.
    const { e, elementLine } = chipLine('188 160 320 320 320 8 200', '188');
    expect(e.params.bitCount).toBe(8);
    expect(e.params.data0).toBe(200);
    expect(e.flags & 2).toBe(2);
    expect(elementLine).toBe('188 160 320 320 320 10 8 200');
  });

  it('421 counter 2 line round-trips its state levels and modulus', () => {
    // 3 bits, three saved Q levels, then the modulus (Counter2Elm.java:34-44).
    const line = '421 160 320 320 320 0 3 0 0 0 5';
    const { e, elementLine } = chipLine(line, '421');
    expect(e.params.bits).toBe(3);
    expect(e.params.voltage0).toBe(0);
    expect(e.params.voltage2).toBe(0);
    expect(e.params.modulus).toBe(5);
    expect(elementLine).toBe(line);
  });

  it('155 D flip-flop line round-trips its saved Q level and default high voltage', () => {
    // One state pin, upstream pins[1], the Q output (DFlipFlopElm.java:48-49),
    // and no bits token, so the stream after the flags is just the saved level
    // (ChipElm.java:367-371 writes one token per state pin).
    const line = '155 160 320 320 320 0 5';
    const { e, elementLine } = chipLine(line, '155');
    expect(e.kind).toBe('dFlipFlop');
    expect(e.params.highVoltage).toBe(5);  // ChipElm.java:56, the no-flag default
    expect(e.params.voltage1).toBe(5);
    expect(postsOf(e)).toHaveLength(4);
    expect(elementLine).toBe(line);
  });

  it('156 JK flip-flop line round-trips its saved Q level on pin 3', () => {
    // The state pin is upstream pins[3] (JKFlipFlopElm.java:46-47), so the
    // saved level lands in the voltage3 param even though it is the only
    // state token on the line.
    const line = '156 160 320 320 320 0 0';
    const { e, elementLine } = chipLine(line, '156');
    expect(e.kind).toBe('jkFlipFlop');
    expect(e.params.highVoltage).toBe(5);
    expect(e.params.voltage3).toBe(0);
    expect(postsOf(e)).toHaveLength(5);
    expect(elementLine).toBe(line);
  });

  it('193 T flip-flop line round-trips its saved Q level and default high voltage', () => {
    // Same shape as the D flip-flop: one state pin, upstream pins[1]
    // (TFlipFlopElm.java:39-40).
    const line = '193 160 320 320 320 0 3.3';
    const { e, elementLine } = chipLine(line, '193');
    expect(e.kind).toBe('tFlipFlop');
    expect(e.params.highVoltage).toBe(5);
    expect(e.params.voltage1).toBe(3.3);
    expect(postsOf(e)).toHaveLength(4);
    expect(elementLine).toBe(line);
  });

  it.each([
    ['155', 'voltage1'],
    ['156', 'voltage3'],
    ['193', 'voltage1'],
  ])('%s carries the high-voltage token under CHIP_CUSTOM_VOLTAGE', (code, state) => {
    // All three flops have needsBits() false, so the optional token the flag
    // introduces is the high voltage, read ahead of the saved level
    // (ChipElm.java:51-56).
    const { e, elementLine } = chipLine(`${code} 160 320 320 320 8192 3.3 5`, code);
    expect(e.flags).toBe(8192);
    expect(e.params.highVoltage).toBe(3.3);
    expect(e.params[state]).toBe(5);
    expect(elementLine).toBe(`${code} 160 320 320 320 8192 3.3 5`);
  });

  it('194 monostable line round-trips the retriggerable flag and delay', () => {
    // The two own tokens follow the optional high voltage; upstream's own
    // dump() drops them, so this port's writer puts them back
    // (MonostableElm.java:40-44).
    const line = '194 160 320 320 320 0 true 0.01';
    const { e, elementLine } = chipLine(line, '194');
    expect(e.params.retriggerable).toBe(1);
    expect(e.params.delay).toBe(0.01);
    expect(elementLine).toBe(line);
  });

  it('195 half adder line round-trips, the high voltage included', () => {
    // The half adder has no tokens of its own: the optional high voltage is
    // the only token after the flags (ChipElm.java:48-56, HalfAdderElm.java).
    const { e, elementLine } = chipLine('195 160 320 320 320 0', '195');
    expect(e.params.highVoltage).toBe(5);
    expect(elementLine).toBe('195 160 320 320 320 0');
    const { elementLine: custom } = chipLine('195 160 320 320 320 8192 6', '195');
    expect(custom).toBe('195 160 320 320 320 8192 6');
  });

  it('161 phase comparator line round-trips, the standard chip stream', () => {
    // Two inputs, one output, no saved state pins, so the optional high
    // voltage is the whole stream here too (PhaseCompElm.java:30-38).
    // phasecomp.txt's line shape, gridded.
    const { e, elementLine } = chipLine('161 160 320 224 320 0', '161');
    expect(e.kind).toBe('phaseComp');
    expect(e.params.highVoltage).toBe(5);
    expect(elementLine).toBe('161 160 320 224 320 0');
    const { elementLine: custom } = chipLine('161 160 320 224 320 8192 6', '161');
    expect(custom).toBe('161 160 320 224 320 8192 6');
  });

  it('196 full adder line round-trips its bits and high voltage', () => {
    // The bits token exists only under FLAG_BITS (bit 1); a flagless line is
    // the 1-bit adder and keeps its byte-exact form (FullAdderElm.java:30-35).
    const { e, elementLine } = chipLine('196 160 320 320 320 2 4', '196');
    expect(e.params.bits).toBe(4);
    expect(elementLine).toBe('196 160 320 320 320 2 4');
    const { elementLine: flagless } = chipLine('196 160 320 320 320 0', '196');
    expect(flagless).toBe('196 160 320 320 320 0');
    const { elementLine: custom } = chipLine('196 160 320 320 320 8194 8 6', '196');
    expect(custom).toBe('196 160 320 320 320 8194 8 6');
  });

  it('197 seven-segment decoder line round-trips the segment type', () => {
    // The segmentType token follows the optional high voltage and there are no
    // saved output levels. Upstream's own dump() drops it, so this port's
    // writer puts it back (SevenSegDecoderElm.java:97-105).
    const { e, elementLine } = chipLine('197 160 320 320 320 0 1', '197');
    expect(e.params.segmentType).toBe(1);
    expect(elementLine).toBe('197 160 320 320 320 0 1');
    const { elementLine: custom } = chipLine('197 160 320 320 320 8192 6 2', '197');
    expect(custom).toBe('197 160 320 320 320 8192 6 2');
  });

  it('433 bus splitter line round-trips its bit count', () => {
    // The bits token, the standard needsBits chip stream; no state pins
    // follow (ChipElm.java:51-55, BusSplitterElm.java).
    const { e, elementLine } = chipLine('433 160 320 320 320 0 4', '433');
    expect(e.params.bits).toBe(4);
    expect(elementLine).toBe('433 160 320 320 320 0 4');
    const { elementLine: custom } = chipLine('433 160 320 320 320 8192 8 6', '433');
    expect(custom).toBe('433 160 320 320 320 8192 8 6');
  });

  it('413 SRAM line round-trips the widths and contents runs', () => {
    // addressBits, dataBits, then the stored contents as runs of consecutive
    // addresses, each run closed by -1 and the stream by -2 (SRAMElm.java:
    // 55-70). Upstream's own dump() drops both the sizes and the contents, so
    // this port's writer restores them.
    const { e, elementLine } = chipLine(
      '413 160 320 320 320 0 2 2 0 1 2 3 -1 2 4 -1 -2',
      '413',
    );
    expect(e.params.addressBits).toBe(2);
    expect(e.params.dataBits).toBe(2);
    // The runs flatten to address-value pairs; the overlapping second run's
    // address 2 wins on the engine's last-wins insert.
    expect(e.params.addr0).toBe(0);
    expect(e.params.val0).toBe(1);
    expect(e.params.addr1).toBe(1);
    expect(e.params.val1).toBe(2);
    expect(e.params.addr2).toBe(2);
    expect(e.params.val2).toBe(3);
    expect(e.params.addr3).toBe(2);
    expect(e.params.val3).toBe(4);
    expect(elementLine).toBe('413 160 320 320 320 0 2 2 0 1 2 3 -1 2 4 -1 -2');
  });

  it('413 SRAM round-trips the display and reload flags', () => {
    // Bit 2 is FLAG_RELOAD_ON_RESET and bit 4 FLAG_HEX_DISPLAY
    // (SRAMElm.java:30-36); both ride the flags verbatim.
    const { elementLine } = chipLine('413 160 320 320 320 6 2 2 1 5 -1 -2', '413');
    expect(elementLine).toBe('413 160 320 320 320 6 2 2 1 5 -1 -2');
    const { elementLine: bare } = chipLine('413 160 320 320 320 0 4 4', '413');
    expect(bare).toBe('413 160 320 320 320 0 4 4');
  });

  it('436 ROM line round-trips the widths and contents runs', () => {
    // The ROM shares the SRAM token stream; only the pin layout differs
    // (ROMElm.java:28-31).
    const { e, elementLine } = chipLine('436 160 320 320 320 0 2 2 1 2 -1 -2', '436');
    expect(e.params.addressBits).toBe(2);
    expect(e.params.dataBits).toBe(2);
    expect(e.params.addr0).toBe(1);
    expect(e.params.val0).toBe(2);
    expect(elementLine).toBe('436 160 320 320 320 0 2 2 1 2 -1 -2');
  });

  it('432 analog mux line round-trips its four tokens', () => {
    // selectBitCount r_on r_off threshold after the optional high voltage,
    // always written like upstream's own dump() (AnalogMuxElm.java:63-65).
    const { e, elementLine } = chipLine('432 160 320 320 320 2 2 20 10000000000 2.5', '432');
    expect(e.params.selectBitCount).toBe(2);
    expect(e.params.r_on).toBe(20);
    expect(e.params.r_off).toBe(1e10);
    expect(e.params.threshold).toBe(2.5);
    expect(elementLine).toBe('432 160 320 320 320 2 2 20 10000000000 2.5');
    const { elementLine: custom } = chipLine('432 160 320 320 320 8192 6 4 1000000 1.5 3', '432');
    expect(custom).toBe('432 160 320 320 320 8192 6 4 1000000 1.5 3');
  });
});

describe('led array file format', () => {
  /** Parses a single `405` line and re-emits it, returning that line. */
  const ledArrayLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('405 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips the grid size byte-for-byte', () => {
    // sizeX sizeY after the optional high-voltage token (LEDArrayElm.java:
    // 32-35). No pin is a state pin, so nothing else follows.
    const line = '405 720 336 784 336 0 8 8';
    const { e, elementLine } = ledArrayLine(line);
    expect(e.params.sizeX).toBe(8);
    expect(e.params.sizeY).toBe(8);
    expect(postsOf(e)).toHaveLength(16);
    expect(elementLine).toBe(line);
  });

  it('a non-square grid keeps both dimensions and its post count', () => {
    const { e, elementLine } = ledArrayLine('405 720 336 784 336 0 4 2');
    expect(e.params.sizeX).toBe(4);
    expect(e.params.sizeY).toBe(2);
    expect(postsOf(e)).toHaveLength(6);
    expect(elementLine).toBe('405 720 336 784 336 0 4 2');
  });

  it('a grid above the dialog bound round-trips its raw tokens with bounded posts', () => {
    // The engine refuses the line by name; until then the layout must stay
    // bounded and a save must not silently rewrite the user's numbers.
    const { e, elementLine } = ledArrayLine('405 720 336 784 336 0 17 8');
    expect(e.params.sizeX).toBe(17);
    expect(e.params.sizeY).toBe(8);
    expect(postsOf(e)).toHaveLength(24);  // clamped 16 + 8
    expect(elementLine).toBe('405 720 336 784 336 0 17 8');
  });
});

describe('7-segment display file format', () => {
  /** Parses a single `157` line and re-emits it, returning that line. */
  const sevenSegLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('157 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips the 7segdecoder corpus line byte-for-byte', () => {
    // baseSegments extraSegment diodeDirection after the optional high
    // voltage (SevenSegElm.java's dump). No saved output levels follow.
    const line = '157 880 232 1000 232 0 7 0 0';
    const { e, elementLine } = sevenSegLine(line);
    expect(e.params.baseSegments).toBe(7);
    expect(e.params.extraSegment).toBe(0);
    expect(e.params.diodeDirection).toBe(0);
    expect(postsOf(e)).toHaveLength(7);
    expect(elementLine).toBe(line);
  });

  it('a custom-voltage colon display carries the hv token before its three', () => {
    // CHIP_CUSTOM_VOLTAGE puts the high voltage first in the chip stream,
    // exactly where the parser looks for it (ChipElm.java:356-366).
    const line = '157 880 232 1000 232 8192 6 14 2 1';
    const { e, elementLine } = sevenSegLine(line);
    expect(e.params.highVoltage).toBe(6);
    expect(e.params.baseSegments).toBe(14);
    expect(e.params.extraSegment).toBe(2);
    expect(e.params.diodeDirection).toBe(1);
    expect(elementLine).toBe(line);
  });
});

describe('demultiplexer file format', () => {
  /** Parses a single `185` line and re-emits it, returning that line. */
  const demuxLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('185 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips the ledarray corpus line byte-for-byte', () => {
    // One select-bit-count token (DeMultiplexerElm.java:61). Three select
    // bits give eight outputs plus three selects plus the data input.
    const line = '185 480 656 656 656 0 3';
    const { e, elementLine } = demuxLine(line);
    expect(e.params.selectBits).toBe(3);
    expect(postsOf(e)).toHaveLength(12);
    expect(elementLine).toBe(line);
  });
});
