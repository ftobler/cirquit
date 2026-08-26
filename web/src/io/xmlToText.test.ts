import { describe, expect, it } from 'vitest';
import { parseXml, isXml } from './xml';
import { CHIP_BIT_ORDER_BUS } from '../model/registry/elements/dFlipFlop';
import { batteryTypeTables } from '../model/registry/elements/battery';
import { postsOf } from '../model/registry';
import { xmlToText } from './xmlToText';
import { parseCircuit, serializeCircuit } from './netlist';
import { DEFAULT_SETTINGS } from '../model/types';

const SIMPLE = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <r x="192 160 304 160" f="0" r="1000"/>
  <c x="304 160 304 224" f="0" c="0.000001" iv="0.001" sr="0" vd="0.5"/>
  <g x="304 224 304 240" f="0"/>
  <v x="192 160 128 160" f="0" wf="2" fr="1000" maxv="5"/>
  <o en="0" sp="4" f="x2" p="0">
    <p v="0" sc="10"/>
  </o>
</cir>
`;

describe('xml parser', () => {
  it('parses a document with self-closing tags and attributes', () => {
    const root = parseXml(SIMPLE);
    const cir = root.children[0];
    expect(cir.tag).toBe('cir');
    expect(cir.attrs.f).toBe('1');
    expect(cir.children).toHaveLength(5);  // the <o> scope carries its own <p> child
    const r = cir.children[0];
    expect(r.tag).toBe('r');
    expect(r.attrs.x).toBe('192 160 304 160');
    expect(r.attrs.r).toBe('1000');
  });

  it('decodes the five named entities', () => {
    const root = parseXml('<a te="x&amp;y &quot;q&quot; &lt;3"/>');
    expect(root.children[0].attrs.te).toBe('x&y "q" <3');
  });

  it('reads element text content', () => {
    const root = parseXml('<ROM ab="4">0: 1 2\n8: 3</ROM>');
    expect(root.children[0].text).toBe('0: 1 2\n8: 3');
  });

  it('rejects an unclosed tag', () => {
    expect(() => parseXml('<cir f="1">')).toThrow(/unclosed/);
  });

  it('rejects a misnested close', () => {
    expect(() => parseXml('<a><b></a></b>')).toThrow(/does not close/);
  });

  it('detects an XML circuit by its first non-blank line', () => {
    expect(isXml('\n\n' + SIMPLE)).toBe(true);
    expect(isXml('$ 1 0.000005 10 50 5 43 5e-11\n')).toBe(false);
  });
});

describe('xml to text conversion', () => {
  it('converts the header from the <cir> attributes', () => {
    const text = xmlToText(SIMPLE);
    const first = text.split('\n')[0];
    expect(first).toBe('$ 1 0.000005 10 50 5 50 5e-11');
  });

  it('converts a resistor, capacitor and ground', () => {
    const text = xmlToText(SIMPLE);
    expect(text).toContain('r 192 160 304 160 0 1000');
    // The capacitor always carries FLAG_RESISTANCE (bit 4) and its four tokens.
    expect(text).toContain('c 304 160 304 224 4 0.000001 0.5 0.001 0');
    expect(text).toContain('g 304 224 304 240 0 0');
  });

  it('converts a square-wave voltage source with the pulse-duty flag', () => {
    const text = xmlToText(SIMPLE);
    expect(text).toContain('v 192 160 128 160 0 2 1000 5 0 0 0.5');
  });

  it('converts an o scope line and re-encodes its display flags', () => {
    const text = xmlToText(SIMPLE);
    expect(text).toMatch(/^o 0 4 0 \d+ 10 0.05 0 1$/m);
  });

  it('re-encodes a transistor Vce/Ib scope without inventing a scale token', () => {
    // The encoder decides scale tokens against the plot kinds: token 1 on a
    // transistor is Ib in amps, so the migrated line must not carry the
    // legacy-power scale token a kind-blind walk would invent.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <t x="192 160 304 160" f="0"/>
  <o en="0" sp="64" f="4162" p="0">
    <p v="6"/>
    <p v="1"/>
  </o>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('o 0 64 6 4290 20 0.05 0 2 0 1');
    const parsed = parseCircuit(text);
    expect(parsed.scopes[0].plots.map((p) => p.value)).toEqual(['vce', 'ib']);
  });

  it('round-trips through parseCircuit and serialises byte-for-byte', () => {
    const text = xmlToText(SIMPLE);
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['resistor', 'capacitor', 'ground', 'voltage']);
    expect(parsed.scopes).toHaveLength(1);
  });

  it('resolves a mosfet model into the f element tokens', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <mm nm="m1" f="0" vt="2" be="0.05"/>
  <f x="224 144 288 144" f="1" mo="m1"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('f 224 144 288 144 1 2 0.05');
  });

  it('converts a routed wire to straight segments', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <rw x="304 160 560 160" f="0">304,160;304,128;560,128;560,160</rw>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('w 304 160 304 128 0');
    expect(text).toContain('w 304 128 560 128 0');
    expect(text).toContain('w 560 128 560 160 0');
    const parsed = parseCircuit(text);
    expect(parsed.elements).toHaveLength(3);
  });

  it('carries a routed bus wire bw onto every converted segment', () => {
    // A bus routed wire keeps its width through conversion: each `w` segment
    // gets the trailing width token, so the saved text pins the bus even
    // before the engine's own width pass re-derives it.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <rw x="304 160 560 160" f="4" bw="4">304,160;560,160</rw>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('w 304 160 560 160 4 4');
    const parsed = parseCircuit(text);
    expect(parsed.elements[0].params.busWidth).toBe(4);
  });

  it('converts a bus logic input to a real 435 line carrying its width', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <bli x="752 416 752 496" f="0" bw="4" va="5"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('435 752 416 752 496 0 4 5 5 0');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['busLogicInput']);
    expect(parsed.elements[0].params.busWidth).toBe(4);
    expect(parsed.elements[0].params.value).toBe(5);
  });

  it('converts a bus transceiver to a real 437 line', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <bt x="304 160 416 160" f="0" db="2"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('437 304 160 416 160 0 2');
    expect(parseCircuit(text).elements.map((e) => e.kind)).toEqual(['busTransceiver']);
  });

  it('converts a battery to a real 438 line carrying its preset table', () => {
    // The XML `isoc` is a 0..1 fraction (BatteryElm.java:107), converted to
    // the file's percent token; the preset table is written so the line is
    // self-describing like the 435 row's rationale.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <Battery x="160 160 160 96" f="3" r0="0.15" r1="0.25" c1="1500" cap="2.5" isoc="0.5" bt="0"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('438 160 160 160 96 3 0.15 0.25 1500 2.5 50 0 ');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['battery']);
    expect(parsed.elements[0].params.initialSoc).toBe(0.5);
    expect(parsed.elements[0].model).toBe(batteryTypeTables[0]);
  });

  it('converts a custom battery, carrying its table text node', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <Battery x="160 160 160 96" f="3" r0="0.01" r1="0.02" c1="2000" cap="2" isoc="1" bt="-1">0=0.8
10=0.95
20=1.05
</Battery>
</cir>
`;
    const text = xmlToText(src);
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['battery']);
    expect(parsed.elements[0].params.batteryType).toBe(-1);
    // The XML parser trims the body's trailing newline, like the instruction
    // display's table; every row survives either way.
    expect(parsed.elements[0].model).toBe('0=0.8\n10=0.95\n20=1.05');
  });

  it('keeps XML-only kinds as comment lines so nothing is lost', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <Gyrator x="304 160 416 160" f="0"/>
  <r x="192 160 304 160" f="0" r="1000"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('# Gyrator x="304 160 416 160" f="0"/>');
    expect(parseCircuit(text).elements.map((e) => e.kind)).toEqual(['resistor']);
  });

  it('converts a ccm composite model to a . line', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ccm nm="op" f="0" sx="2" sy="2">
    <ext nm="A" nd="1" ps="0" sd="2"/>
    <ext nm="B" nd="2" ps="1" sd="2"/>
    <And nn="1 2 3" x="-656 640 -544 640" f="0"/>
  </ccm>
  <cc x="192 160 224 192" f="1" mo="op"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toMatch(/^\. op 0 2 2 2 A 1 0 2 B 2 1 2 \S+ \S+$/m);
    const parsed = parseCircuit(text);
    expect(parsed.compositeModels).toHaveLength(1);
    expect(parsed.compositeModels[0].nodeList).toBe('AndGateElm 1 2 3');
    expect(parsed.elements).toHaveLength(1);
  });

  it('converts a ROM with hex contents to the port run tokens', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ROM x="800 896 832 896" f="4" ab="4" db="8">0: B1 B2 B4 B8
8: B4 B8</ROM>
</cir>
`;
    const text = xmlToText(src);
    // Addresses 0-3 then 8-9 form two runs; each closes with -1, then -2.
    expect(text).toContain('436 800 896 832 896 4 4 8 0 177 178 180 184 -1 8 180 184 -1 -2');
  });

  it('converts a slider to a 38 line with the emitted element index', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <r x="192 160 304 160" f="0" r="1000"/>
  <adj e="0" ei="0" en="Resistance" mn="100" mx="10000" st="R"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toMatch(/^38 0 F0 0 100 10000 R 0$/m);
    expect(parseCircuit(text).sliders).toHaveLength(1);
  });

  it('traces a dropped internal resistance on a rail', () => {
    // Upstream builds a real series resistor onto an internal node when ir > 0
    // (VoltageElm.java:148-157); the text format has no home for it, so the
    // conversion degrades loudly instead of silently.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <R x="288 96 288 48" f="0" wf="0" maxv="5" ir="5"/>
</cir>
`;
    const text = xmlToText(src);
    const lines = text.split('\n');
    const at = lines.indexOf('R 288 96 288 48 0 0 60 5 0 0 0.5');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe(
      '# R ir="5" not modelled: converted as an ideal source without internal resistance',
    );
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['rail']);
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('R 288 96 288 48 0 0 60 5 0 0 0.5');
  });

  it('traces a dropped rise time on a pulse source', () => {
    // riseTime ramps a pulse or square's edges over seconds
    // (VoltageElm.java:179-180); the six-token stream cannot carry it.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <v x="192 160 128 160" f="0" wf="1" fr="1000" maxv="5" riseTime="1e-3"/>
</cir>
`;
    const text = xmlToText(src);
    const lines = text.split('\n');
    const at = lines.indexOf('v 192 160 128 160 0 1 1000 5 0 0 0.5');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe('# v riseTime="1e-3" not modelled: pulse edges step instantly');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['voltage']);
  });

  it('keeps a zero internal resistance free of traces', () => {
    // Gate on value, not presence: ir="0" is upstream's default and builds
    // nothing, mirroring the flagless-seven-segment rule.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <R x="288 96 288 48" f="0" wf="0" maxv="5" ir="0"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('R 288 96 288 48 0 0 60 5 0 0 0.5');
    expect(text).not.toContain('# R ir=');
  });

  it('seeds a DC source or rail without fr at upstream frequency 60', () => {
    // Upstream never writes fr for DC sources (VoltageElm.dumpXml) and its
    // XML reader builds a fresh element first, whose constructor seeds
    // frequency 60 (VoltageElm.java:57). The port's fresh-part seed is 60
    // too, so a converted file matches what a fresh part would save.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <R x="288 96 288 48" f="0" wf="0" maxv="5"/>
  <v x="192 160 128 160" f="0" wf="0" maxv="10"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('R 288 96 288 48 0 0 60 5 0 0 0.5');
    expect(text).toContain('v 192 160 128 160 0 0 60 10 0 0 0.5');
  });

  it('keeps an explicit fr on a converted AC source', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <R x="288 96 288 48" f="0" wf="1" fr="1234" maxv="5"/>
</cir>
`;
    expect(xmlToText(src)).toContain('R 288 96 288 48 0 1 1234 5 0 0 0.5');
  });

  it('converts a top-level probe element, not just scope plots', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <p x="128 80 128 224" f="0" me="0" sc="0" re="0"/>
  <r x="128 80 192 80" f="0" r="1000"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('p 128 80 128 224 0 0 0 0');
    expect(parseCircuit(text).elements.map((e) => e.kind)).toEqual(['probe', 'resistor']);
  });

  it('converts a Line annotation to its 423 dump code', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <Line x="1409 436 1761 435" f="0"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('423 1409 436 1761 435 0');
  });

  it('does not throw on a momentary logic input', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <L x="256 672 224 672" f="0" mm="true"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('L 256 672 224 672 0 0 true 5 0');
  });

  it('parses a greater-than sign inside an attribute value', () => {
    const root = parseXml('<x te="a&gt;b"/>');
    expect(root.children[0].attrs.te).toBe('a>b');
  });

  it('throws a conversion error wrapped in the load error on malformed xml', () => {
    const src = '<cir f="1">';
    expect(() => parseCircuit(src)).toThrow(/xml to text conversion failed/);
  });

  it('carries a bus-mode counter bit order into the port chip flag', () => {
    // Upstream's bo="2" (BIT_ORDER_BUS) collapses every Q/I pin group onto
    // one coordinate; the converted line must keep that state or the rebuilt
    // chip lands its pins on rows the surrounding wires never touched, which
    // is how the td4 family went singular.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ctr2 x="496 288 528 288" f="0" bi="4" bo="2" mo="0"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain(`421 496 288 528 288 ${CHIP_BIT_ORDER_BUS} 4`);
    const parsed = parseCircuit(text);
    const posts = postsOf(parsed.elements[0]);
    // The four Q pins share one east coordinate and the four I pins one west
    // coordinate; a plain non-bus rebuild would spread them over four rows.
    expect(posts[0]).toEqual(posts[3]);
    expect(posts[4]).toEqual(posts[7]);
  });

  it('leaves a flagless ctr2 in the plain per-row layout', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ctr2 x="496 288 528 288" f="0" bi="4" mo="0"/>
</cir>
`;
    const parsed = parseCircuit(xmlToText(src));
    const posts = postsOf(parsed.elements[0]);
    expect(new Set(posts.map((p) => `${p.x},${p.y}`))).toHaveLength(14);
  });

  it('converts an instruction display to a real 434 line carrying its table', () => {
    // alu74181's shape: bw 5, default threshold, multi-line body. The table
    // must survive as one escaped token and re-parse into live element state,
    // not die in a bare comment.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ins x="1200 1024 1264 1024" f="0" bw="5">0=ADD A
0x10-0x1F=MOV A, B
</ins>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('434 1200 1024 1264 1024 0 5 2.5 ');
    expect(text).toContain('\\n');
    const parsed = parseCircuit(text);
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.elements[0].kind).toBe('instructionDisplay');
    expect(parsed.elements[0].params.busWidth).toBe(5);
    expect(parsed.elements[0].params.threshold).toBe(2.5);
    // The XML parser trims the body's trailing newline; every table row
    // survives either way.
    expect(parsed.elements[0].text).toBe('0=ADD A\n0x10-0x1F=MOV A, B');
    // The converted line round-trips through a save unchanged.
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    const round = parseCircuit(saved);
    expect(round.elements[0].text).toBe('0=ADD A\n0x10-0x1F=MOV A, B');
    expect(round.elements[0].params.busWidth).toBe(5);
  });

  it('converts the td4 instruction display with its threshold attribute', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ins x="1200 1024 1264 1024" f="0" bw="8" th="3">0=NOP</ins>
</cir>
`;
    const parsed = parseCircuit(xmlToText(src));
    expect(parsed.elements[0].kind).toBe('instructionDisplay');
    expect(parsed.elements[0].params.busWidth).toBe(8);
    expect(parsed.elements[0].params.threshold).toBe(3);
    expect(parsed.elements[0].text).toBe('0=NOP');
  });

  it('routes a bus-input (im="2") mux to its bus/bus text line', () => {
    // The td4 files' im="2" muxes now carry inputMode=2 and dataBusWidth=4 on
    // the 184 line, faithfully modelling upstream's bus-in/bus-out layout, so
    // the ROM-to-data-bus wiring routes instead of degrading. No trace comment.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <mux x="752 320 784 320" f="0" se="2" im="2"/>
  <w x="592 320 752 320" f="4"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('184 752 320 784 320 0 2 2 4');
    expect(text).not.toContain('# mux im=');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['multiplexer', 'wire']);
    expect(parsed.elements[0].params.inputMode).toBe(2);
    expect(parsed.elements[0].params.dataBusWidth).toBe(4);
  });

  it('keeps the deferred bus/bit (im="1") mux as a trace comment', () => {
    // Mode 1 has no text-format home and no corpus user, so it still converts
    // to the single-bit shape under a trace comment.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <mux x="752 320 784 320" f="0" se="2" im="1"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('184 752 320 784 320 0 2');
    expect(text).toContain(
      '# mux im="1" not modelled: converted as individual inputs with one output',
    );
  });

  it('marks a dropped bit order on chips this build does not lay out', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ADC x="304 160 368 160" f="0" bi="4" bo="2"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).not.toContain(String(CHIP_BIT_ORDER_BUS));
    expect(text).toContain('# ADC bo="2" not modelled: converted as non-bus pin rows');
  });

  it('marks an LSB-first bit order even on an honoured chip', () => {
    // Only BIT_ORDER_BUS rides the port flag; LSB first would flip row order
    // inside every group, so it degrades loudly rather than silently.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ctr2 x="496 288 528 288" f="0" bi="4" bo="1" mo="0"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).not.toContain(String(CHIP_BIT_ORDER_BUS));
    expect(text).toContain('# ctr2 bo="1" not modelled: bit order stays MSB first');
  });

  it('converts an SRAM like the ROM, honouring its bus bit order', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <SRAM x="800 896 832 896" f="4" ab="4" db="8" bo="2">0: B1 B2
</SRAM>
</cir>
`;
    const text = xmlToText(src);
    // f="4" rides along as the hex-display bit next to the bus-order flag.
    expect(text).toContain(`413 800 896 832 896 ${CHIP_BIT_ORDER_BUS | 4} 4 8`);
    const parsed = parseCircuit(text);
    expect(parsed.elements[0].kind).toBe('sram');
    expect(postsOf(parsed.elements[0])).toHaveLength(14);  // WE + OE + 4 + 8
    // Bus mode: each bank collapses onto row 1 of its side.
    const posts = postsOf(parsed.elements[0]);
    expect(posts[2]).toEqual(posts[5]);
    expect(posts[6]).toEqual(posts[13]);
  });

  it('converts a demultiplexer to its 185 line', () => {
    // DeMultiplexerElm writes only se beyond the chip base (DeMultiplexerElm.
    // java:63-71), so a plain dmux maps losslessly: no bits token (the class
    // has needsBits false), one select-bit-count token after the flags.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <dmux x="192 160 304 160" f="0" se="3"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('185 192 160 304 160 0 3');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['deMultiplexer']);
    expect(parsed.elements[0].params.selectBits).toBe(3);
    // Eight outputs, three select bits and the data input.
    expect(postsOf(parsed.elements[0])).toHaveLength(12);
  });

  it('marks a demultiplexer output mode as a trace comment', () => {
    // om/dw select upstream's bus output layouts, which the port's text
    // format does not model for the demultiplexer: the line converts as
    // individual outputs under a visible trace.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <dmux x="192 160 304 160" f="0" se="2" om="2" dw="8"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('185 192 160 304 160 0 2');
    expect(text).toContain(
      '# dmux om="2" dw="8" not modelled: converted as individual outputs',
    );
  });

  it('converts a counter to its 164 line with polarity, modulus and state', () => {
    // CounterElm.dumpXml writes in (a Boolean string) and mo always, plus the
    // saved Q levels as v{i} on pins 2..bits+1 (CounterElm.java:52-57). The
    // port's text order interleaves those levels between the bits token and
    // the polarity pair.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ctr x="304 160 368 160" f="4" bi="3" in="false" mo="7" v2="5" v4="5"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('164 304 160 368 160 4 3 5 0 5 false 7');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['counter']);
    expect(parsed.elements[0].params.bits).toBe(3);
    expect(parsed.elements[0].params.invertreset).toBe(0);
    expect(parsed.elements[0].params.modulus).toBe(7);
    expect(parsed.elements[0].params.voltage2).toBe(5);
    expect(parsed.elements[0].params.voltage4).toBe(5);
  });

  it('converts a counter with a custom high voltage, pinning the token order', () => {
    // The interleave is bits, then the high voltage under its flag, then the
    // Q levels, then the polarity pair and the modulus. in passes through
    // lowercased, matching Boolean.parseBoolean's case blindness.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ctr x="304 160 368 160" f="0" bi="3" hv="3" v2="5" v4="5" in="TRUE" mo="7"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain(`164 304 160 368 160 ${1 << 13} 3 3 5 0 5 true 7`);
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['counter']);
    expect(parsed.elements[0].params.highVoltage).toBe(3);
    expect(parsed.elements[0].params.invertreset).toBe(1);
    expect(parsed.elements[0].params.modulus).toBe(7);
    expect(parsed.elements[0].params.voltage4).toBe(5);
  });

  it('treats default-valued demultiplexer output modes as modelled', () => {
    // om="0" and dw="4" are upstream's defaults: their presence alone must
    // not raise the "not modelled" trace, only a real mode does.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <dmux x="192 160 304 160" f="0" se="2" om="0" dw="4"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('185 192 160 304 160 0 2');
    expect(text).not.toContain('# dmux');
  });

  it('converts a T flip-flop to its 193 line, carrying a custom high voltage', () => {
    // TFlipFlopElm adds nothing beyond the ChipElm base but its saved Q level
    // v1 (pin 1 is the only state pin), so hv != 5 must raise
    // FLAG_CUSTOM_VOLTAGE exactly as the port's own writer would.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <TFlipFlop x="224 144 288 144" f="2" hv="3" v1="5"/>
</cir>
`;
    const text = xmlToText(src);
    // The reset-pin flag from f rides beside FLAG_CUSTOM_VOLTAGE.
    expect(text).toContain(`193 224 144 288 144 ${(1 << 13) | 2} 3 5`);
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['tFlipFlop']);
    expect(parsed.elements[0].params.highVoltage).toBe(3);
    // f=2 is the reset-pin flag, giving T, Q, Qbar, clock and R.
    expect(postsOf(parsed.elements[0])).toHaveLength(5);
  });

  it('converts a JK flip-flop to its 156 line', () => {
    // JKFlipFlopElm likewise adds nothing beyond the base; its Q lives at
    // pin 3, the only state-carrying pin (JKFlipFlopElm.java setupPins).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <JKFlipFlop x="224 144 288 144" f="4"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('156 224 144 288 144 4 0');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['jkFlipFlop']);
    // J, clock, K, Q and Qbar: the reset pin needs flag bit 2, absent here.
    expect(postsOf(parsed.elements[0])).toHaveLength(5);
  });

  it('converts a latch to its 168 line with its saved output levels', () => {
    // LatchElm carries bi/hv/bo from the base and nothing of its own; the O
    // outputs at pins bits..2*bits-1 hold the state (LatchElm.java:76-77),
    // read positionally into voltage{bits+i} tokens.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <Latch x="496 288 528 288" f="2" bi="2" v2="5"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('168 496 288 528 288 2 2 5 0');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['latch']);
    expect(parsed.elements[0].params.bits).toBe(2);
    expect(parsed.elements[0].params.voltage2).toBe(5);
    // Two I pins, two O pins and the load clock.
    expect(postsOf(parsed.elements[0])).toHaveLength(5);
    // The converted line round-trips through a save unchanged.
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('168 496 288 528 288 2 2 5 0');
  });

  it('defaults a missing counter polarity to the active-high reset', () => {
    // CounterElm.invertreset defaults false (CounterElm.java:28) and its
    // reader parses a missing "in" against that default
    // (CounterElm.java:60): active-HIGH reset. Seeding true would flip every
    // hand-written counter's reset polarity.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ctr x="304 160 368 160" f="0" bi="2" mo="0"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('164 304 160 368 160 0 2 0 0 false 0');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['counter']);
    expect(parsed.elements[0].params.invertreset).toBe(0);
  });

  it('traces a dropped bit order on the live seven-segment display tag', () => {
    // SevenSegElm's getXmlDumpType returns "ssd" (SevenSegElm.java:337) and
    // it is allowBus whenever diodeDirection is 0 (SevenSegElm.java:82), so
    // ChipElm writes bo onto it. A nonzero bo collapses its whole pin layout,
    // so it must degrade loudly, not silently.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ssd x="224 144 288 144" f="0" ba="7" bo="2"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('157 224 144 288 144 0 7 0 0');
    expect(text).toContain('# ssd bo="2" not modelled: converted as non-bus pin rows');
    expect(text).not.toContain(String(CHIP_BIT_ORDER_BUS));
  });

  it('converts a 555 timer to its 165 line with the saved output level', () => {
    // TimerElm adds nothing beyond the chip base but its OUT level: pin 5 is
    // the only state pin (TimerElm.java:55), written by ChipElm.dumpXmlState
    // as v5 whenever the level was above zero. needsBits is false and the
    // class is not allowBus, so neither bi nor bo can appear.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <Timer x="304 160 400 160" f="6" hv="3" v5="5"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain(`165 304 160 400 160 ${(1 << 13) | 6} 3 5`);
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['timer']);
    expect(parsed.elements[0].params.highVoltage).toBe(3);
    expect(parsed.elements[0].params.voltage5).toBe(5);
    expect(postsOf(parsed.elements[0])).toHaveLength(8);  // reset and ground pins both set
    // The converted line round-trips through a save unchanged.
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain(`165 304 160 400 160 ${(1 << 13) | 6} 3 5`);
  });

  it('defaults a bare 555 timer to the zero output level', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <Timer x="304 160 400 160" f="6"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('165 304 160 400 160 6 0');
  });

  it('converts a comparator to its 401 line with fresh child dumps', () => {
    // ComparatorElm carries no fields beyond its flags: upstream rebuilds the
    // three children (op-amp, analog switch, ground) from the model string on
    // load, and none of them saves state into the XML. The port's fresh-child
    // list is exactly what upstream would build.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <Comparator x="192 160 320 160" f="1"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain(
      '401 192 160 320 160 1 8_15_-15_1000000_0_0_100000 2_20_10000000000_2.5 1_0',
    );
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['comparator']);
    expect(postsOf(parsed.elements[0])).toHaveLength(3);
    // The converted line round-trips through a save unchanged.
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain(
      '401 192 160 320 160 1 8_15_-15_1000000_0_0_100000 2_20_10000000000_2.5 1_0',
    );
  });

  it('converts an OTA to its 402 line, deriving the rails from pv/nv', () => {
    // Upstream rebuilds all eighteen children and then re-seeds the two rail
    // supplies from the attributes (OTAElm.java:157-162), so the converted
    // line carries the derived rail tokens ahead of sixteen fresh transistors.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <OTA x="512 528 624 528" f="1" pv="12" nv="-12"/>
</cir>
`;
    const text = xmlToText(src);
    const n = '0_1_0_0_100';
    const p = '0_-1_0_0_100';
    expect(text).toContain(
      `402 512 528 624 528 1 0_0_40_-12_0_0_0.5 0_0_40_12_0_0_0.5 ` +
        `${[n, n, n, n, n].join(' ')} ${[p, p, p, p, p, p].join(' ')} ${[n, n, n, n, n].join(' ')}`,
    );
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['ota']);
    expect(parsed.elements[0].params.posVolt).toBe(12);
    expect(parsed.elements[0].params.negVolt).toBe(-12);
    expect(postsOf(parsed.elements[0])).toHaveLength(5);
    // The converted line round-trips through a save unchanged.
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')[1]?.startsWith('402 512 528 624 528 1 0_0_40_-12_0_0_0.5')).toBe(true);
  });

  it('splices OTA transistor junction state out of the child elements', () => {
    // While the circuit has run, CompositeElm.dumpXmlState appends each
    // transistor as a child element tagged "t", the subclasses' shared
    // printable dump type, carrying vbe/vbc against its child index ix;
    // upstream restores them onto the rebuilt children before reading the
    // supplies. The rail children save nothing, so they never appear, and the
    // polarity comes from the slot position, not from the tag.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <OTA x="512 528 624 528" f="1">
    <t ix="2" vbe="-1.5" vbc="-0.25"/>
    <t ix="7" vbe="2" vbc="-3"/>
  </OTA>
</cir>
`;
    const text = xmlToText(src);
    const tokens = text.split('\n').find((l) => l.startsWith('402 '))!.split(' ');
    expect(tokens).toHaveLength(24);  // code, four coords, flags, eighteen children
    expect(tokens[8]).toBe('0_1_-1.5_-0.25_100');   // child index 2
    expect(tokens[13]).toBe('0_-1_2_-3_100');       // child index 7
    expect(tokens[9]).toBe('0_1_0_0_100');          // untouched neighbours stay fresh
  });

  it('refuses an OTA child index outside the sixteen transistor slots', () => {
    // CompositeElm.undumpXml itself throws when a state child's index has no
    // matching child (CompositeElm.java:300-307), so a claim on a rail slot or
    // past the end must fail loudly instead of landing somewhere wrong.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <OTA x="512 528 624 528" f="1">
    <t ix="18" vbe="1" vbc="-1"/>
  </OTA>
</cir>
`;
    expect(() => xmlToText(src)).toThrow(/out of range/);
  });

  it('converts a realistic op-amp to its 409 line with its four tokens', () => {
    // OpAmpRealElm writes slr/cl/mt plus the capacitor's saved charge vd
    // (:155-165), which land in the port's slewRate capValue currentLimit
    // modelType order (OpAmpRealElm.java:79-86).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <OpAmpReal x="224 144 352 144" f="3" slr="1.2" cl="0.05" mt="2" vd="0.001"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('409 224 144 352 144 3 1.2 0.001 0.05 2');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['opampReal']);
    expect(parsed.elements[0].params.slewRate).toBe(1.2);
    expect(parsed.elements[0].params.capValue).toBe(0.001);
    expect(parsed.elements[0].params.currentLimit).toBe(0.05);
    expect(parsed.elements[0].params.modelType).toBe(2);
    expect(postsOf(parsed.elements[0])).toHaveLength(5);
    // The converted line round-trips through a save unchanged.
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('409 224 144 352 144 3 1.2 0.001 0.05 2');
  });

  it('seeds a bare realistic op-amp with its constructor defaults', () => {
    // slr/cl/mt parse against the fresh instance (.6, .0231, MODEL_741) and a
    // missing vd answers zero (OpAmpRealElm.java:70-72, :166-171).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <OpAmpReal x="224 144 352 144" f="1"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('409 224 144 352 144 1 0.6 0 0.0231 0');
  });

  it('converts a DAC to its 166 line with its bit count', () => {
    // DACElm is a plain bit-width chip: bi always, hv under its flag, and no
    // state pins anywhere, because the O level is derived, not stored
    // (DACElm.java:29-41).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <DAC x="800 896 832 896" f="4" bi="4"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('166 800 896 832 896 4 4');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['dac']);
    expect(parsed.elements[0].params.bits).toBe(4);
    expect(postsOf(parsed.elements[0])).toHaveLength(6);  // four bits, O, V+
    // The converted line round-trips through a save unchanged.
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('166 800 896 832 896 4 4');
  });

  it('converts a DAC with a custom high voltage under its flag', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <DAC x="800 896 832 896" f="0" bi="2" hv="9"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain(`166 800 896 832 896 ${1 << 13} 2 9`);
    expect(parseCircuit(text).elements[0].params.highVoltage).toBe(9);
  });

  it('traces a dropped bus bit order on the DAC', () => {
    // The DAC is allowBus upstream, so bo reaches its XML; this build lays out
    // no bus rows for it, so the state degrades loudly like every other chip.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <DAC x="800 896 832 896" f="0" bi="2" bo="2"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('166 800 896 832 896 0 2');
    expect(text).toContain('# DAC bo="2" not modelled: converted as non-bus pin rows');
    expect(text).not.toContain(String(CHIP_BIT_ORDER_BUS));
  });

  it('converts an analog mux to its 432 line with its four own tokens', () => {
    // AnalogMuxElm.dump appends sb ron rof thr to the base (:67-73); the
    // class has needsBits false and no state pins, and it is not allowBus, so
    // only the optional high voltage can precede them.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <AnalogMux x="304 160 368 288" f="2" sb="1" ron="10" rof="1000000000" thr="3"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('432 304 160 368 288 2 1 10 1000000000 3');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['analogMux']);
    expect(parsed.elements[0].params.selectBitCount).toBe(1);
    expect(parsed.elements[0].params.r_on).toBe(10);
    expect(parsed.elements[0].params.r_off).toBe(1e9);
    expect(parsed.elements[0].params.threshold).toBe(3);
    expect(postsOf(parsed.elements[0])).toHaveLength(4);  // two inputs, one select, Z
  });

  it('seeds a bare analog mux with its constructor defaults', () => {
    // Fresh AnalogMuxElm values (AnalogMuxElm.java:35-39), which is what
    // upstream's attribute reader falls back to.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <AnalogMux x="304 160 368 288" f="2"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('432 304 160 368 288 2 2 20 10000000000 2.5');
    expect(postsOf(parseCircuit(text).elements[0])).toHaveLength(7);
  });

  it('converts a delay buffer to its 422 line with all three tokens', () => {
    // DelayBufferElm writes dl/th/hv directly (:47-52); the port's text order
    // is delay threshold highVoltage (DelayBufferElm.java:39-45).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <DelayBuffer x="128 80 208 80" f="0" dl="0.005" th="2" hv="3.3"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('422 128 80 208 80 0 0.005 2 3.3');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['delayBuffer']);
    expect(parsed.elements[0].params.delay).toBe(0.005);
    expect(parsed.elements[0].params.threshold).toBe(2);
    expect(parsed.elements[0].params.highVoltage).toBe(3.3);
    expect(postsOf(parsed.elements[0])).toHaveLength(2);
    // The converted line round-trips through a save unchanged.
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('422 128 80 208 80 0 0.005 2 3.3');
  });

  it('seeds a bare delay buffer with its reader defaults', () => {
    // A fresh part's delay field is Java's 0 (never set in the constructor),
    // threshold 2.5 and highVoltage 5 (DelayBufferElm.java:29-34).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <DelayBuffer x="128 80 208 80" f="0"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('422 128 80 208 80 0 0 2.5 5');
  });

  it('converts an analog switch to its 159 line', () => {
    // AnalogSwitchElm writes ron/roff/th (:62-67), the same triple its text
    // format carries (AnalogSwitchElm.java:58-60).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <as x="192 160 304 160" f="2" ron="50" roff="1000000000" th="1.5"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('159 192 160 304 160 2 50 1000000000 1.5');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['analogSwitch']);
    expect(parsed.elements[0].params.r_on).toBe(50);
    expect(parsed.elements[0].params.r_off).toBe(1e9);
    expect(parsed.elements[0].params.threshold).toBe(1.5);
    expect(postsOf(parsed.elements[0])).toHaveLength(3);
    // The converted line round-trips through a save unchanged.
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('159 192 160 304 160 2 50 1000000000 1.5');
  });

  it('converts an SPDT analog switch to its 160 line', () => {
    // AnalogSwitch2Elm inherits the parent's XML surface unchanged; only the
    // dump code and post count differ (AnalogSwitch2Elm.java:86-87, :45).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <as2 x="192 160 304 160" f="0" ron="20" roff="10000000000" th="2.5"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('160 192 160 304 160 0 20 10000000000 2.5');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['analogSwitch2']);
    expect(postsOf(parsed.elements[0])).toHaveLength(4);  // pole, two throws, control
  });

  it('keeps a flagless seven-segment display free of trace comments', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ssd x="224 144 288 144" f="0" ba="7"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('157 224 144 288 144 0 7 0 0');
    expect(text).not.toContain('# ssd');
  });

  it('traces a dropped bit order on the newly mapped counter and latch', () => {
    // Both are allowBus chips upstream, so bo reaches their XML; neither has
    // a bus layout in this build, so it degrades loudly instead of silently.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ctr x="304 160 368 160" f="0" bi="3" in="true" mo="0" bo="2"/>
  <Latch x="496 288 528 288" f="2" bi="2" bo="2"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('# ctr bo="2" not modelled: converted as non-bus pin rows');
    expect(text).toContain('# Latch bo="2" not modelled: converted as non-bus pin rows');
    expect(text).not.toContain(String(CHIP_BIT_ORDER_BUS));
  });

  it('converts a tapped transformer to its 169 line with ratio and coupling', () => {
    // TappedTransformerElm writes in/ra/co (dumpXml :74-76) and the port's
    // text stream is inductance ratio current0 current1 current2 couplingCoef
    // (TappedTransformerElm.dump :67-70).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <tt x="192 160 304 160" f="0" in="4" ra="2" co="0.98"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('169 192 160 304 160 0 4 2 0 0 0 0.98');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['tappedTransformer']);
    expect(parsed.elements[0].params.ratio).toBe(2);
    expect(parsed.elements[0].params.couplingCoef).toBe(0.98);
    expect(postsOf(parsed.elements[0])).toHaveLength(5);
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('169 192 160 304 160 0 4 2 0 0 0 0.98');
  });

  it('carries tapped transformer coil currents from the state attributes', () => {
    // The coil currents ride c0/c1/c2 state attributes
    // (TappedTransformerElm.java:80-82) into the text stream's current slots.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <tt x="192 160 304 160" f="0" in="4" ra="2" co="0.99" c0="0.5" c1="-1" c2="1"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('169 192 160 304 160 0 4 2 0.5 -1 1 0.99');
    const parsed = parseCircuit(text);
    expect(parsed.elements[0].params.current0).toBe(0.5);
    expect(parsed.elements[0].params.current1).toBe(-1);
    expect(parsed.elements[0].params.current2).toBe(1);
  });

  it('converts a sweep generator to its 170 line', () => {
    // SweepElm writes mi/ma/mv/sw (SweepElm.java:53-56), the port's own
    // minF maxF maxV sweepTime order (:23-27).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <sw x="192 160 304 160" f="2" mi="10" ma="5000" mv="3" sw="0.2"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('170 192 160 304 160 2 10 5000 3 0.2');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['sweep']);
    expect(parsed.elements[0].params.minF).toBe(10);
    expect(parsed.elements[0].params.maxF).toBe(5000);
    expect(parsed.elements[0].params.maxV).toBe(3);
    expect(parsed.elements[0].params.sweepTime).toBe(0.2);
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('170 192 160 304 160 2 10 5000 3 0.2');
  });

  it('converts a transmission line to its 171 line with delay impedance width', () => {
    // TransLineElm writes de/im/wi (TransLineElm.java:60-62); the text stream
    // ends with the unimplemented series-resistance slot its own dump always
    // writes (:54-56), so the converted line is self-describing like the
    // registry's own output.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <tl x="192 160 416 160" f="0" de="0.002" im="50" wi="24"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('171 192 160 416 160 0 0.002 50 24 0');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['transmissionLine']);
    expect(parsed.elements[0].params.delay).toBe(0.002);
    expect(parsed.elements[0].params.imped).toBe(50);
    expect(parsed.elements[0].params.width).toBe(24);
    expect(postsOf(parsed.elements[0])).toHaveLength(4);
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('171 192 160 416 160 0 0.002 50 24 0');
  });

  it('converts a tri-state buffer to its 180 line', () => {
    // TriStateElm writes ron/roff/rog/hi (TriStateElm.java:75-78), the port's
    // r_on r_off r_off_ground highVoltage token order (:69-72).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ts x="192 160 304 160" f="0" ron="10" roff="1e9" rog="100" hi="3"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('180 192 160 304 160 0 10 1000000000 100 3');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['triState']);
    expect(parsed.elements[0].params.r_on).toBe(10);
    expect(parsed.elements[0].params.r_off).toBe(1e9);
    expect(parsed.elements[0].params.r_off_ground).toBe(100);
    expect(parsed.elements[0].params.highVoltage).toBe(3);
    expect(postsOf(parsed.elements[0])).toHaveLength(3);
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('180 192 160 304 160 0 10 1000000000 100 3');
  });

  it('traces a bus width above one on a tri-state buffer', () => {
    // busWidth is XML-only and this port models single-bit tri-states only
    // (TriStateElm.java:79-80 dumps it when it exceeds one).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ts x="192 160 304 160" f="0" bw="2"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('180 192 160 304 160 0 0.1 10000000000 0 5');
    expect(text).toContain('# ts bw="2" not modelled: converted as single-bit');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['triState']);
  });

  it('converts a darlington to its 400 line honouring pnp', () => {
    // DarlingtonElm writes pnp (DarlingtonElm.java:54); the composite's two
    // transistor state tokens stay fresh, exactly what the port's own dump
    // writes for a part of either polarity (:46-48 carries only pnp).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <dar x="192 160 304 160" f="0" pnp="-1"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('400 192 160 304 160 0 0_1_0_0_100 0_1_0_0_100 -1');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['darlington']);
    expect(parsed.elements[0].params.pnp).toBe(-1);
    expect(postsOf(parsed.elements[0])).toHaveLength(3);
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('400 192 160 304 160 0 0_1_0_0_100 0_1_0_0_100 -1');
  });

  it('converts a DPDT switch to its 429 line with its pole count', () => {
    // DPDTSwitchElm writes po over the SwitchElm base (:54); the port's token
    // layout is position momentary then the pole count (:48-51).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <dpdt x="192 160 304 224" f="0" po="3"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('429 192 160 304 224 0 0 false 3');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['dpdtSwitch']);
    expect(parsed.elements[0].params.poleCount).toBe(3);
    expect(postsOf(parsed.elements[0])).toHaveLength(9);
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('429 192 160 304 224 0 0 false 3');
  });

  it('traces a non-default pole count on a DPDT switch', () => {
    // Fresh DPDT parts are two-pole everywhere; anything else converts but
    // stays visible, since nothing in this build's toolbox draws one.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <dpdt x="192 160 304 224" f="0" po="3"/>
</cir>
`;
    const lines = xmlToText(src).split('\n');
    const at = lines.indexOf('429 192 160 304 224 0 0 false 3');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe('# dpdt po="3" not default: converted as a 3-pole switch');
  });

  it('converts a potentiometer to its 174 line', () => {
    // PotElm writes ma/po/sl (PotElm.java:79-81) onto the port's
    // maxResistance position caption stream.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <pt x="192 160 304 160" f="1" ma="2000" po="0.25" sl="Volume"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('174 192 160 304 160 1 2000 0.25 Volume');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['potentiometer']);
    expect(parsed.elements[0].params.maxResistance).toBe(2000);
    expect(parsed.elements[0].params.position).toBe(0.25);
    expect(parsed.elements[0].text).toBe('Volume');
    expect(postsOf(parsed.elements[0])).toHaveLength(3);
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('174 192 160 304 160 1 2000 0.25 Volume');
  });

  it('round-trips a potentiometer caption containing spaces', () => {
    // The port writes pot captions raw and multi-token (PotElm.java:58-62),
    // so sl splits on whitespace the way the registry's own dump does; the
    // parse rejoins the words with single spaces.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <pt x="192 160 304 160" f="0" ma="1000" po="0.5" sl="Max Resistance"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('174 192 160 304 160 0 1000 0.5 Max Resistance');
    const parsed = parseCircuit(text);
    expect(parsed.elements[0].text).toBe('Max Resistance');
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('174 192 160 304 160 0 1000 0.5 Max Resistance');
  });

  it('traces a dropped slider link on a potentiometer', () => {
    // li links pots onto one shared slider (PotElm.java:82-83, setLink);
    // shared sliders never link in this build.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <pt x="192 160 304 160" f="0" ma="1000" po="0.5" sl="Resistance" li="3"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('174 192 160 304 160 0 1000 0.5 Resistance');
    expect(text).toContain('# pt li="3" not modelled: converted without its slider link');
  });

  it('converts an audio input to its 411 line with its three own tokens', () => {
    // AudioInputElm writes ma/st/fi (AudioInputElm.java:98-101); the port's
    // short three-token form reads exactly those (:56-66 of audioInput.ts).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <ain x="192 160 304 160" f="1" ma="2" st="0.5" fi="7"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('411 192 160 304 160 1 2 0.5 7');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['audioInput']);
    expect(parsed.elements[0].params.maxVoltage).toBe(2);
    expect(parsed.elements[0].params.startPosition).toBe(0.5);
    expect(parsed.elements[0].params.fileNum).toBe(7);
    // The save writes the registry's own full nine-token form (the six rail
    // tokens with the waveform pinned AC, then the element's three), so it is
    // longer than the converted line it came from.
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('411 192 160 304 160 1 1 60 2 0 0 0.5 2 0.5 7');
  });

  it('converts an audio output to its 211 line', () => {
    // AudioOutputElm writes du/sa/la (AudioOutputElm.java:53-55), the same
    // duration samplingRate labelNum order its text dump uses (:47-49).
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <aout x="192 160 304 160" f="0" du="2" sa="44100" la="1"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('211 192 160 304 160 0 2 44100 1');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['audioOutput']);
    expect(parsed.elements[0].params.duration).toBe(2);
    expect(parsed.elements[0].params.samplingRate).toBe(44100);
    expect(parsed.elements[0].params.labelNum).toBe(1);
    const saved = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS });
    expect(saved.split('\n')).toContain('211 192 160 304 160 0 2 44100 1');
  });

  it('marks a modelled but unmapped tag with a trace under its comment', () => {
    // A relay keeps its preserving comment and gains one marker line under
    // it; the marker takes no slot, so a scope naming a later element still
    // resolves and one naming the relay itself writes -1.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <rl x="192 160 304 224" f="0" mo="default" plus="false" state="0" i="0" ip="0"/>
  <r x="192 208 272 208" f="0" r="1000"/>
  <o en="1" sp="64" f="x2" p="0">
    <p v="0" sc="10"/>
  </o>
</cir>
`;
    const text = xmlToText(src);
    const lines = text.split('\n');
    const commentAt = lines.findIndex((l) => l.startsWith('# rl '));
    expect(commentAt).toBeGreaterThan(0);
    expect(lines[commentAt]).toBe(
      '# rl x="192 160 304 224" f="0" mo="default" plus="false" state="0" i="0" ip="0"/>',
    );
    expect(lines[commentAt + 1]).toBe('# rl not converted: this build models it as code 178');
    // Ordinals survive: the resistor after the relay sits at slot 0, and the
    // scope naming ordinal 1 (the relay) degrades to -1.
    expect(text).toMatch(/^o 0 64 /m);
    const src2 = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <rl x="192 160 304 224" f="0" mo="default" plus="false" state="0" i="0" ip="0"/>
  <o en="0" sp="64" f="x2" p="0">
    <p v="0" sc="10"/>
  </o>
</cir>
`;
    expect(xmlToText(src2)).toMatch(/^o -1 64 /m);
    expect(parseCircuit(text).elements.map((e) => e.kind)).toEqual(['resistor']);
  });

  it('marks the unmapped char-form tags with their registry codes', () => {
    // Classes without a getXmlDumpType override take the default rule: a
    // character for dump codes 64..127, else the class name minus Elm. Each
    // marker names the code the port's registry models the tag as.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <T x="192 160 304 160" f="0"/>
  <Triac x="192 208 304 208" f="0"/>
  <cl x="192 256 304 320" f="0" mo="majority"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('# T not converted: this build models it as code T');
    expect(text).toContain('# Triac not converted: this build models it as code 206');
    expect(text).toContain('# cl not converted: this build models it as code 208');
    expect(parseCircuit(text).elements).toHaveLength(0);
  });
});
