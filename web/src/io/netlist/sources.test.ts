import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { makeElement } from '../../state/store';
import { postsOf } from '../../model/registry';
import { VOLTAGE_SHOW_VOLTAGE } from '../../model/registry/flags';
import { DEFAULT_SETTINGS } from '../../model/types';

describe('voltage source file format', () => {
  /** Parses a single `v` line and re-emits it, returning the `v` line. */
  const voltageLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('v ')) ?? '';
    return { e, out, elementLine };
  };

  it('a legacy FLAG_COS line loads as a cosine', () => {
    // indmultfreq.txt's shape: flags 2, sine waveform, no phase token.
    // Upstream clears the bit and materialises phaseShift = pi/2
    // (VoltageElm.java:80-83).
    const { e } = voltageLine('v 176 96 176 32 2 1 30.0 5.0 0.0');
    expect(e.params.phaseShift).toBe(Math.PI / 2);
    expect(e.flags & 2).toBe(0);
  });

  it('a legacy pulse line without the duty flag takes 1/(2*pi)', () => {
    // ladder.txt's shape: flags 0, pulse waveform, no duty token. Upstream
    // forces the legacy duty whenever FLAG_PULSE_DUTY is absent
    // (VoltageElm.java:85-88), and the stored flags then record the duty as
    // authoritative so a rebuild does not re-apply it to a later edit.
    const { e } = voltageLine('v 64 128 64 48 0 5 40.0 5.0 0.0');
    expect(e.params.dutyCycle).toBeCloseTo(1 / (2 * Math.PI), 12);
    expect(e.flags & 4).toBe(4);
  });

  it('a pulse line carrying FLAG_PULSE_DUTY keeps its duty token', () => {
    const { e } = voltageLine('v 1 2 3 4 4 5 40.0 5.0 0.0 0.0 0.5');
    expect(e.params.dutyCycle).toBe(0.5);
    expect(e.flags & 4).toBe(4);
  });

  it('clears a stray pulse-duty flag on a non-pulse line', () => {
    // A non-pulse line must not carry bit 4: a save would otherwise claim a
    // duty token it has nothing to do with.
    const { e, elementLine } = voltageLine('v 1 2 3 4 4 1 40.0 5.0 0.0');
    expect(e.flags & 4).toBe(0);
    expect(elementLine).toBe('v 1 2 3 4 0 1 40 5 0 0 0.5');
  });

  it('round-trips a legacy FLAG_COS line to the canonical upstream form', () => {
    // The flag is cleared and the pi/2 phase is written out in radians, the
    // form a save from upstream's own load would produce.
    const { elementLine } = voltageLine('v 176 96 176 32 2 1 30.0 5.0 0.0');
    expect(elementLine).toBe('v 176 96 176 32 0 1 30 5 0 1.5707963267948966 0.5');
  });

  it('preserves FLAG_CIRCLE_SYMBOL on save', () => {
    // Bit 8 is part of the interchange format: it chooses the circled +/−
    // symbol over the battery plates, and the load/save pair must keep it
    // (VoltageElm.java:31).
    const { e, elementLine } = voltageLine('v 1 2 3 4 8 0 40.0 5.0 0.0 0.0 0.5');
    expect(e.flags & 8).toBe(8);
    expect(elementLine).toBe('v 1 2 3 4 8 0 40 5 0 0 0.5');
  });

  it('keeps a plain DC line flag-free through the round trip', () => {
    // The default DC symbol is the battery, so a fresh DC line carries no bit
    // 8 and the save must not invent one.
    const { e, elementLine } = voltageLine('v 1 2 3 4 0 0 40.0 5.0 0.0 0.0 0.5');
    expect(e.flags & 8).toBe(0);
    expect(elementLine).toBe('v 1 2 3 4 0 0 40 5 0 0 0.5');
  });

  it('carries FLAG_TIME_SPEC through the round trip without token drift', () => {
    // 36 = FLAG_PULSE_DUTY (4) | FLAG_TIME_SPEC (32). The time-spec bit is a
    // dialog preference: it rides the flags word verbatim and the tokens stay
    // the six-token stream, because frequency and dutyCycle remain the stored
    // truth (VoltageElm.java:33, :495).
    const { e, elementLine } = voltageLine('v 1 2 3 4 36 5 40.0 5.0 0.0 0.0 0.5');
    expect(e.flags & 32).toBe(32);
    expect(elementLine).toBe('v 1 2 3 4 36 5 40 5 0 0 0.5');
  });

  it('keeps FLAG_TIME_SPEC on a non-timing waveform, where it is inert', () => {
    // A sine carrying the bit keeps it through save and load: nothing strips
    // an unknown flag bit, and the waveform rows gate on hasTimingOptions.
    const { e, elementLine } = voltageLine('v 1 2 3 4 32 1 40.0 5.0 0.0 0.0 0.5');
    expect(e.flags & 32).toBe(32);
    expect(elementLine).toBe('v 1 2 3 4 32 1 40 5 0 0 0.5');
  });

  it('an untouched line with phase and duty tokens saves byte-for-byte', () => {
    // The dialog edits degrees and percent (VoltageElm.java:573,:578) but the
    // file stores radians and fractions on both sides, so a load-save pair
    // that never commits an edit reproduces the line exactly.
    const { e, elementLine } = voltageLine(
      'v 64 128 64 48 4 5 40.0 5.0 0.0 1.5707963267948966 0.56',
    );
    expect(e.params.phaseShift).toBe(Math.PI / 2);
    expect(e.params.dutyCycle).toBe(0.56);
    expect(elementLine).toBe('v 64 128 64 48 4 5 40 5 0 1.5707963267948966 0.56');
  });

  it('a fresh voltage source dumps the upstream constructor defaults', () => {
    // The toolbar constructor runs 60 Hz at 5 V with the caption flag on
    // (VoltageElm.java:52-58); the file constructor's 40 Hz seed must not
    // reach a fresh part.
    const e = makeElement('voltage', 0, 0, 0, 64);
    expect(e.params.frequency).toBe(60);
    expect(e.flags).toBe(16);  // VOLTAGE_SHOW_VOLTAGE
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('v 0 0 0 64 16 0 60 5 0 0 0.5');
  });

  it('a v line that stops after the waveform token keeps the file constructor seed', () => {
    // grid2.txt's shape: upstream's token constructor seeds frequency 40 and
    // only the tokens present override it (VoltageElm.java:65-77), so a short
    // legacy line loads there even though a fresh part starts at 60.
    const { e } = voltageLine('v 272 256 272 208 0 0');
    expect(e.params.waveform).toBe(0);
    expect(e.params.frequency).toBe(40);
    expect(e.params.maxVoltage).toBe(5);
  });
});

describe('rail file format', () => {
  /** Parses a single `R` line and re-emits it, returning the `R` line. */
  const railLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('R ')) ?? '';
    return { e, out, elementLine };
  };

  it('round-trips the six source tokens', () => {
    const { e, elementLine } = railLine('R 128 176 96 176 0 1 1000 2 0 0 0.5');
    expect(e.kind).toBe('rail');
    expect(e.params.waveform).toBe(1);
    expect(elementLine).toBe('R 128 176 96 176 0 1 1000 2 0 0 0.5');
  });

  it('a bare R line keeps the file constructor frequency seed', () => {
    // grid.txt's shape: no tokens at all, so everything stays where upstream's
    // token constructor seeds it (RailElm extends VoltageElm's file
    // constructor, VoltageElm.java:65-66).
    const { e } = railLine('R 272 64 272 16 0');
    expect(e.params.frequency).toBe(40);
    expect(e.params.maxVoltage).toBe(5);
  });

  it('a fresh rail dumps the upstream constructor defaults', () => {
    const e = makeElement('rail', 0, 0, 64, 0);
    expect(e.params.frequency).toBe(60);
    expect(e.flags).toBe(16);  // VOLTAGE_SHOW_VOLTAGE, inherited from VoltageElm
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('R 0 0 64 0 16 0 60 5 0 0 0.5');
  });
});

describe('current source file format', () => {
  /** Parses a single `i` line and re-emits it, returning the `i` line. */
  const currentLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('i ')) ?? '';
    return { e, out, elementLine };
  };

  it('forces a zero current token to upstream 0.01 on load', () => {
    // CurrentElm.java:43-44: the file constructor replaces 0 with 0.01, so the
    // line a legacy save wrote as `0` comes back as a working 0.01 A source.
    const { e, elementLine } = currentLine('i 100 100 200 100 0 0.0 0');
    expect(e.params.current).toBe(0.01);
    expect(elementLine).toBe('i 100 100 200 100 0 0.01 0');
  });

  it('keeps a nonzero current and its maxVoltage token', () => {
    const { e, elementLine } = currentLine('i 100 100 200 100 0 0.5 3.0');
    expect(e.params.current).toBe(0.5);
    expect(e.params.maxVoltage).toBe(3);
    expect(elementLine).toBe('i 100 100 200 100 0 0.5 3');
  });

  it('maxVoltage survives a save/load round-trip', () => {
    // `maxVoltage` used to be parsed but never carried, so a save wrote 0 and
    // a reload lost the compliance. Now the registry field and engine carry it.
    const { e, elementLine } = currentLine('i 100 100 200 100 0 0.5 3.0');
    expect(e.params.maxVoltage).toBe(3);
    expect(elementLine.endsWith(' 3')).toBe(true);
    const [again] = parseCircuit(elementLine).elements;
    expect(again.params.maxVoltage).toBe(3);
    expect(again.params.current).toBe(0.5);
  });
});

describe('batch-3 source and chip file formats', () => {
  /** Parses a single element line and re-emits it, returning that line. */
  const elementLine = (line: string, code: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith(`${code} `)) ?? '' };
  };

  it('a sweep line round-trips byte-for-byte', () => {
    // minF maxF maxV sweepTime (SweepElm.java:40-45), with FLAG_LOG (1) and
    // FLAG_BIDIR (2) as flags 3.
    const line = '170 240 160 208 160 3 20 1000 5 0.1';
    const { e, elementLine: out } = elementLine(line, '170');
    expect(e.params.minF).toBe(20);
    expect(e.params.maxF).toBe(1000);
    expect(e.params.maxV).toBe(5);
    expect(e.params.sweepTime).toBe(0.1);
    expect(e.flags).toBe(3);
    expect(out).toBe(line);
  });

  it('a fresh sweep dumps the upstream constructor defaults', () => {
    // FLAG_BIDIR (2) is the default (SweepElm.java:35).
    const e = makeElement('sweep', 0, 0, 64, 0);
    expect(e.flags).toBe(2);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('170 0 0 64 0 2 20 4000 5 0.1');
  });

  it('a transmission line round-trips byte-for-byte', () => {
    // delay imped width, then the series-resistance token upstream always
    // writes as 0 (TransLineElm.java:55).
    const line = '171 0 0 100 0 0 0.005 75 64 0';
    const { e, elementLine: out } = elementLine(line, '171');
    expect(e.params.delay).toBe(0.005);
    expect(e.params.imped).toBe(75);
    expect(e.params.width).toBe(64);
    expect(out).toBe(line);
  });

  it('a fresh transmission line defaults delay to upstream 0.005', () => {
    // Upstream's fresh constructor sets delay = 1000*maxTimeStep = 0.005
    // (TransLineElm.java:34), which the file save must agree with.
    const e = makeElement('transmissionLine', 0, 0, 32, 0);
    expect(e.params.delay).toBe(0.005);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('171 0 0 32 0 0 0.005 75 32 0');
  });

  it('an audio output line round-trips byte-for-byte', () => {
    // duration samplingRate labelNum (AudioOutputElm.java:41-49).
    const line = '211 512 384 576 384 0 1 8000 1';
    const { e, elementLine: out } = elementLine(line, '211');
    expect(e.params.duration).toBe(1);
    expect(e.params.samplingRate).toBe(8000);
    expect(e.params.labelNum).toBe(1);
    expect(out).toBe(line);
  });

  it('an AM source line round-trips byte-for-byte', () => {
    // carrierfreq signalfreq maxVoltage (AMElm.java:40-42).
    const line = '200 240 160 208 160 0 1000 40 5';
    const { e, elementLine: out } = elementLine(line, '200');
    expect(e.params.carrierFreq).toBe(1000);
    expect(e.params.signalFreq).toBe(40);
    expect(e.params.maxVoltage).toBe(5);
    expect(out).toBe(line);
  });

  it('an FM source line round-trips byte-for-byte', () => {
    // carrierfreq signalfreq maxVoltage deviation (FMElm.java:43-46).
    const line = '201 240 160 208 160 0 800 40 5 200';
    const { e, elementLine: out } = elementLine(line, '201');
    expect(e.params.carrierFreq).toBe(800);
    expect(e.params.signalFreq).toBe(40);
    expect(e.params.maxVoltage).toBe(5);
    expect(e.params.deviation).toBe(200);
    expect(out).toBe(line);
  });

  it('an AM line with FLAG_COS clears the bit, keeping the sine carrier', () => {
    // The token constructor clears bit 2 without materialising any phase
    // (AMElm.java:43-45), so a loaded cosine-flagged line saves without it.
    const line = '200 240 160 208 160 2 1000 40 5';
    const { e, elementLine: out } = elementLine(line, '200');
    expect(e.flags & 2).toBe(0);
    expect(out).toBe('200 240 160 208 160 0 1000 40 5');
  });

  it('a fresh AM source dumps the upstream constructor defaults', () => {
    const e = makeElement('am', 0, 0, 64, 0);
    expect(e.flags).toBe(0);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('200 0 0 64 0 0 1000 40 5');
  });

  it('a fresh FM source dumps the upstream constructor defaults', () => {
    const e = makeElement('fm', 0, 0, 64, 0);
    expect(e.flags).toBe(0);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('201 0 0 64 0 0 800 40 5 200');
  });

  it('an audio input line round-trips byte-for-byte', () => {
    // The rail's six source tokens, then the element's own three; maxVoltage
    // appears twice in the full 9-token form (AudioInputElm.java:57-66).
    const line = '411 240 160 208 160 0 1 40 5 0 0 0.5 5 0 3';
    const { e, elementLine: out } = elementLine(line, '411');
    expect(e.params.waveform).toBe(1);
    expect(e.params.maxVoltage).toBe(5);
    expect(e.params.startPosition).toBe(0);
    expect(e.params.fileNum).toBe(3);
    expect(out).toBe(line);
  });

  it('a 3-token audio input line loads into the element own tokens', () => {
    // Upstream's own dump() writes only the trailing three, because the base
    // CircuitElm.dump carries no tokens (AudioInputElm.java:70-73); the
    // canonical save restores the full nine.
    const line = '411 240 160 208 160 0 5 0 3';
    const { e, elementLine: out } = elementLine(line, '411');
    expect(e.params.maxVoltage).toBe(5);
    expect(e.params.startPosition).toBe(0);
    expect(e.params.fileNum).toBe(3);
    expect(out).toBe('411 240 160 208 160 0 1 60 5 0 0 0.5 5 0 3');
  });

  it('a fresh audio input dumps the upstream constructor defaults', () => {
    const e = makeElement('audioInput', 0, 0, 64, 0);
    expect(e.flags).toBe(16);  // VOLTAGE_SHOW_VOLTAGE, inherited from the rail
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('411 0 0 64 0 16 1 60 5 0 0 0.5 5 0 0');
  });

  it('a data input line round-trips byte-for-byte', () => {
    // sampleLength scaleFactor fileNum after the rail's six
    // (DataInputElm.java:55-68).
    const line = '424 240 160 208 160 0 1 40 5 0 0 0.5 0.001 1 7';
    const { e, elementLine: out } = elementLine(line, '424');
    expect(e.params.sampleLength).toBe(0.001);
    expect(e.params.scaleFactor).toBe(1);
    expect(e.params.fileNum).toBe(7);
    expect(out).toBe(line);
  });

  it('a data input line keeps the FLAG_REPEAT bit', () => {
    const line = '424 240 160 208 160 256 1 40 5 0 0 0.5 0.001 1 7';
    const { e, elementLine: out } = elementLine(line, '424');
    expect(e.flags & 256).toBe(256);
    expect(out).toBe(line);
  });

  it('a 3-token data input line loads into the element own tokens', () => {
    const line = '424 240 160 208 160 0 0.001 1 7';
    const { e, elementLine: out } = elementLine(line, '424');
    expect(e.params.sampleLength).toBe(0.001);
    expect(e.params.scaleFactor).toBe(1);
    expect(e.params.fileNum).toBe(7);
    expect(out).toBe('424 240 160 208 160 0 1 60 5 0 0 0.5 0.001 1 7');
  });

  it('a fresh data input dumps the upstream constructor defaults', () => {
    const e = makeElement('dataInput', 0, 0, 64, 0);
    expect(e.flags).toBe(16);  // VOLTAGE_SHOW_VOLTAGE, inherited from the rail
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('424 0 0 64 0 16 1 60 5 0 0 0.5 0.001 1 0');
  });

  it('a delay buffer line round-trips byte-for-byte', () => {
    // delay, then the optional threshold highVoltage pair
    // (DelayBufferElm.java:35-46).
    const line = '422 240 160 304 160 0 0.01 2.5 5';
    const { e, elementLine: out } = elementLine(line, '422');
    expect(e.params.delay).toBe(0.01);
    expect(e.params.threshold).toBe(2.5);
    expect(e.params.highVoltage).toBe(5);
    expect(out).toBe(line);
  });

  it('a fresh delay buffer dumps the upstream constructor defaults', () => {
    // The no-arg constructor never sets delay, so a fresh part starts at 0
    // (DelayBufferElm.java:29-34); the writer restores the two optional
    // tokens the upstream dump would drop.
    const e = makeElement('delayBuffer', 0, 0, 64, 0);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('422 0 0 64 0 0 0 2.5 5');
  });

  it('an external voltage line round-trips its escaped name', () => {
    // The rail tokens, then the escaped name (ExtVoltageElm.java:28-33).
    const line = '418 304 80 256 80 0 1 40 5 0 0 0.5 pin\\s8';
    const { e, elementLine: out } = elementLine(line, '418');
    expect(e.text).toBe('pin 8');
    expect(out).toBe(line);
  });

  it('an external voltage with an empty name keeps the \\0 escape', () => {
    // A save must not rewrite the empty name to 'ext', or the line loses a
    // token the user's file carried.
    const line = '418 0 0 32 0 0 1 40 5 0 0 0.5 \\0';
    const { e, elementLine: out } = elementLine(line, '418');
    expect(e.text).toBe('');
    expect(out).toBe(line);
  });

  it('a fresh external voltage falls back to the name ext', () => {
    // Only a part that never carried a name token writes the constructor
    // default (ExtVoltageElm.java:27), on the VOLTAGE_SHOW_VOLTAGE flag.
    const e = makeElement('extVoltage', 0, 0, 32, 0);
    expect(e.flags).toBe(16);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('418 0 0 32 0 16 1 40 5 0 0 0.5 ext');
  });

  it('a var rail round-trips its raw caption tokens', () => {
    // The six source tokens, then the raw caption; a `+` is stored as `%2B`
    // so it survives the token format (VarRailElm.java:42-45).
    const line = '172 272 288 192 288 0 6 4.5 5 0 0 0.5 Voltage %2B 1';
    const { e, elementLine: out } = elementLine(line, '172');
    expect(e.text).toBe('Voltage + 1');
    expect(out).toBe(line);
  });

  it('a timer line with the ground pin round-trips its OUT state', () => {
    // flags 4 is FLAG_GROUND; the trailing token is the saved OUT level
    // (TimerElm.java:55).
    const line = '165 240 128 256 128 4 0';
    const { e, elementLine: out } = elementLine(line, '165');
    expect(e.params.voltage5).toBe(0);
    expect(out).toBe(line);
  });

  it('a timer with a ground pin keeps 8 posts, matching the engine', () => {
    // The engine's hasReset() forces the reset pin when the ground pin is set
    // (TimerElm.java:62), so flags 4 still allocates 8 posts; a stale 7-post
    // layout would alias the reset and ground nodes.
    const e = parseCircuit('165 0 0 32 0 4 0').elements[0];
    expect(postsOf(e)).toHaveLength(8);
  });

  it('a timer with custom high voltage writes the token and its flag', () => {
    // CHIP_CUSTOM_VOLTAGE (8192) makes the high-voltage token optional; a
    // non-5 value saves the token and the flag together (ChipElm.java:51-56).
    const line = '165 240 128 256 128 8192 3.3 0';
    const { e, elementLine: out } = elementLine(line, '165');
    expect(e.params.highVoltage).toBe(3.3);
    expect(out).toBe(line);
  });

  it('a VCO line round-trips byte-for-byte with an empty pin stream', () => {
    // pll.txt:2's shape. Six posts but none is a state pin, so nothing follows
    // the flags unless CHIP_CUSTOM_VOLTAGE introduces a high voltage
    // (ChipElm.java:367-371 writes only state pins; VCOElm.java:29-42).
    const line = '158 432 224 464 224 0';
    const { e, elementLine: out } = elementLine(line, '158');
    expect(e.kind).toBe('vco');
    expect(postsOf(e)).toHaveLength(6);
    expect(out).toBe(line);
  });

  it('a VCO with custom high voltage carries the token ahead of the pins', () => {
    const line = '158 432 224 464 224 8192 6';
    const { e, elementLine: out } = elementLine(line, '158');
    expect(e.params.highVoltage).toBe(6);
    expect(postsOf(e)).toHaveLength(6);
    expect(out).toBe(line);
  });
});

describe('noise file format', () => {
  /** Parses a single `n` line and re-emits it, returning the `n` line. */
  const noiseLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('n ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips the six source tokens byte-for-byte', () => {
    // waveform frequency maxVoltage bias phaseShift dutyCycle, the voltage
    // source stream every rail carries (VoltageElm.java:69-75).
    const line = 'n 480 272 432 272 0 6 40 5 0 0 0.5';
    const { e, elementLine } = noiseLine(line);
    expect(e.kind).toBe('noise');
    expect(e.params.waveform).toBe(6);  // WF_NOISE
    expect(e.params.frequency).toBe(40);
    expect(e.params.maxVoltage).toBe(5);
    expect(e.params.bias).toBe(0);
    expect(e.params.phaseShift).toBe(0);
    expect(e.params.dutyCycle).toBe(0.5);
    expect(postsOf(e)).toHaveLength(1);
    expect(elementLine).toBe(line);
  });

  it('pins any waveform token back to noise on load', () => {
    // bandnoise.txt:12 verbatim carries waveform 1, which the token
    // constructor reads and NoiseElm then overwrites with WF_NOISE whatever
    // it said (NoiseElm.java:24-28), so the canonical save writes 6.
    const { e, elementLine } = noiseLine('n 480 272 432 272 0 1 40 5 0 0 0.5');
    expect(e.params.waveform).toBe(6);
    expect(e.params.frequency).toBe(40);
    expect(elementLine).toBe('n 480 272 432 272 0 6 40 5 0 0 0.5');
  });

  it('a bare n line keeps the file-constructor seeds on every field', () => {
    // Upstream seeds frequency 40, maxVoltage 5 and dutyCycle .5 before
    // reading (VoltageElm.java:65-68), and this port's writer emits the whole
    // stream unconditionally, so a truncated line grows its missing tokens.
    const { e, elementLine } = noiseLine('n 144 144 144 112 16');
    expect(e.params.waveform).toBe(6);
    expect(e.params.frequency).toBe(40);
    expect(e.params.maxVoltage).toBe(5);
    expect(e.params.bias).toBe(0);
    expect(e.params.phaseShift).toBe(0);
    expect(e.params.dutyCycle).toBe(0.5);
    expect(elementLine).toBe('n 144 144 144 112 16 6 40 5 0 0 0.5');
  });
});

describe('antenna file format', () => {
  /** Parses a single `A` line and re-emits it, returning that line. */
  const antennaLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('A ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips the six source tokens byte-for-byte', () => {
    // AntennaElm extends RailElm, so the tail is the voltage source's
    // waveform frequency maxVoltage bias phaseShift dutyCycle stream. The
    // waveform is forced to AC on load (AntennaElm.java:24-28), which the
    // canonical line already carries.
    const line = 'A 144 144 144 112 16 1 40 5 0 0 0.5';
    const { e, elementLine } = antennaLine(line);
    expect(e.kind).toBe('antenna');
    expect(e.flags & VOLTAGE_SHOW_VOLTAGE).toBe(VOLTAGE_SHOW_VOLTAGE);
    expect(e.params.waveform).toBe(1);
    expect(e.params.frequency).toBe(40);
    expect(e.params.maxVoltage).toBe(5);
    expect(e.params.bias).toBe(0);
    expect(e.params.phaseShift).toBe(0);
    expect(e.params.dutyCycle).toBe(0.5);
    expect(elementLine).toBe(line);
  });

  it('forces a non-AC waveform token back to AC on load', () => {
    // The token constructor reads the waveform but overwrites it with WF_AC
    // whatever it says (AntennaElm.java:24-28), and the save writes the
    // forced value so a reload agrees.
    const { e, elementLine } = antennaLine('A 144 144 144 112 0 5 40 5 0 0 0.5');
    expect(e.params.waveform).toBe(1);
    expect(elementLine).toBe('A 144 144 144 112 0 1 40 5 0 0 0.5');
  });

  it('the corpus bare line gains the seeded source tokens on save', () => {
    // amdetect.txt's only antenna line stops after the flags. Upstream's
    // token constructor seeds frequency 40 and maxVoltage 5 before reading
    // (VoltageElm.java:66-67), so the save restores those seeds instead of
    // writing zeros a reload would turn into a silent DC rail.
    const { e, elementLine } = antennaLine('A 144 144 144 112 0');
    expect(e.params.frequency).toBe(40);
    expect(e.params.maxVoltage).toBe(5);
    expect(e.params.waveform).toBe(1);
    expect(elementLine).toBe('A 144 144 144 112 0 1 40 5 0 0 0.5');
  });
});
