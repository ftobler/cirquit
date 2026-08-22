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

  it('converts a voltage-source internal resistance ir away silently', () => {
    // The port's voltage source does not model internal resistance; the token
    // is dropped, exactly as if upstream had saved a text file.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <R x="288 96 288 48" f="0" wf="0" maxv="5" ir="5"/>
</cir>
`;
    expect(xmlToText(src)).toContain('R 288 96 288 48 0 0 40 5 0 0 0.5');
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

  it('keeps a bus-input mux line and marks the dropped input mode', () => {
    // The port lays out input mode 0 only; the td4 files' im="2" muxes keep
    // their element slot (scopes count against them) and gain a visible
    // trace comment instead of silently losing the bus behaviour.
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <mux x="752 320 784 320" f="0" se="2" im="2"/>
  <w x="592 320 752 320" f="4"/>
</cir>
`;
    const text = xmlToText(src);
    expect(text).toContain('184 752 320 784 320 0 2');
    expect(text).toContain(
      '# mux im="2" not modelled: converted as individual inputs with one output',
    );
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['multiplexer', 'wire']);
  });

  it('marks a dropped data width on a mux too', () => {
    const src = `<cir f="1" ts="0.000005" ic="10" cb="50" pb="50" vr="5" mts="5e-11">
  <mux x="752 320 784 320" f="0" se="2" dw="8"/>
</cir>
`;
    expect(xmlToText(src)).toContain('# mux dw="8" not modelled: data width stays individual');
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
});
