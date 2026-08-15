import { describe, expect, it } from 'vitest';
import { parseXml, isXml } from './xml';
import { xmlToText } from './xmlToText';
import { parseCircuit } from './netlist';

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
});
