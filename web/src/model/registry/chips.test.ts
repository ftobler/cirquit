import { describe, expect, it, beforeEach } from 'vitest';
import { CHIP_PINS, chipPinsOf } from './chips';
import { chipExtentsOf, postCountOf, postsOf } from '../registry';
import { canMirror } from '../transform';
import { chipPosts } from './elements/dFlipFlop';
import { csPins } from './elements/vcvs';
import { ccsPairPins } from './elements/ccvs';
import { customCompositePins } from './elements/customComposite';
import { makeToolElement } from '../../state/helpers';
import { createTestHarness, selectHarnessChip } from '../testHarness';
import {
  clearSessionModels,
  getModel,
  modelToEngineSpec,
  parseCompositeModelLine,
  registerSessionModel,
} from '../../io/subcircuits';
import { GRID_SIZE, type CircuitElement, type Point } from '../types';

// A freshly placed part of the kind, with the id the placement flow assigns.
const toolElement = (kind: string): CircuitElement => ({
  ...makeToolElement(kind, 0, 0, 64, 0),
  id: 1,
});

// Every kind whose upstream class extends ChipElm, directly or through
// SRAMElm (ROMElm): the exact set the Create Test command targets
// (TestCreator.java, `instanceof ChipElm`). The controlled sources are
// ChipElm subclasses upstream too (through VCCSElm) but stay out on purpose,
// and DelayBufferElm extends CircuitElm directly, so none of them appear.
const CHIP_KINDS = [
  'adc',
  'analogMux',
  'busSplitter',
  'busTransceiver',
  'cc2',
  'counter',
  'counter2',
  'customLogic',
  'dac',
  'dFlipFlop',
  'decimalDisplay',
  'deMultiplexer',
  'fullAdder',
  'halfAdder',
  'jkFlipFlop',
  'latch',
  'ledArray',
  'monostable',
  'multiplexer',
  'phaseComp',
  'pisoShift',
  'ringCounter',
  'rom',
  'seqGen',
  'sevenSeg',
  'sevenSegDecoder',
  'sipoShift',
  'sram',
  'tFlipFlop',
  'timeDelayRelay',
  'timer',
  'vco',
].sort();

describe('CHIP_PINS kind set', () => {
  it('carries exactly the upstream ChipElm kinds', () => {
    expect([...CHIP_PINS.keys()].sort()).toEqual(CHIP_KINDS);
  });
});

describe('chip extents', () => {
  beforeEach(() => clearSessionModels());

  // The mirror shift's span source must cover every kind whose upstream class
  // overrides flipX with the body-width shift: the ChipElm family, plus the
  // optocoupler (fixed 2x2), the custom composite (model extents) and the four
  // controlled sources (VCCSElm extends ChipElm).
  const EXTENTS_KINDS = [...CHIP_PINS.keys(), 'optocoupler', 'customComposite', 'vcvs', 'vccs', 'ccvs', 'cccs'];

  /** Recomputes the posts from `chipExtentsOf` the way each family's def
   *  routes its own geometry through chipPosts, so any drift between the
   *  extents and the positional sizes shows up as a coordinate diff. */
  const postsFromExtents = (e: CircuitElement): Point[] | undefined => {
    const ext = chipExtentsOf(e)!;
    const pins = CHIP_PINS.get(e.kind);
    if (pins !== undefined) return chipPosts(e, ext.sx, ext.sy, pins(e));
    if (e.kind === 'vcvs' || e.kind === 'vccs') return chipPosts(e, ext.sx, ext.sy, csPins(e, ['V+', 'V-'], true));
    if (e.kind === 'ccvs') return chipPosts(e, ext.sx, ext.sy, ccsPairPins(e, ['V+', 'V-'], true));
    if (e.kind === 'cccs') return chipPosts(e, ext.sx, ext.sy, ccsPairPins(e, ['O+', 'O-'], false));
    if (e.kind === 'customComposite') return chipPosts(e, ext.sx, ext.sy, customCompositePins(e));
    return undefined;  // optocoupler: geometry is its own, checked below
  };

  for (const kind of EXTENTS_KINDS) {
    it(`reproduces ${kind}'s own post coordinates from the extents`, () => {
      const e = toolElement(kind);
      const ext = chipExtentsOf(e);
      expect(ext, `${kind} declares extents`).toBeDefined();
      const expected = postsFromExtents(e);
      if (expected !== undefined) expect(expected).toEqual(postsOf(e));
    });

    it(`offers Mirror for a horizontal ${kind}`, () => {
      expect(canMirror(toolElement(kind))).toBe(true);
    });
  }

  it("reports the optocoupler's fixed 2x2 body at full spacing", () => {
    expect(chipExtentsOf(toolElement('optocoupler'))).toEqual({ sx: 2, sy: 2, cspc2: 32 });
  });

  it("reads a resolved composite's extents off its model and the stub off the fallback", () => {
    registerSessionModel(
      parseCompositeModelLine(
        '. mir 0 2 1 2 in 1 0 2 out 3 0 3 ' +
          'ResistorElm\\s1\\s2\\rResistorElm\\s2\\s3 ' +
          '0\\\\s1000\\s0\\\\s1000',
      )!,
    );
    const resolved = {
      ...toolElement('customComposite'),
      text: 'mir',
      model: modelToEngineSpec(getModel('mir')!),
    };
    expect(chipExtentsOf(resolved)).toEqual({ sx: 2, sy: 1, cspc2: 32 });
    // Unresolvable name: the fallback stub upstream always resolves.
    expect(chipExtentsOf(toolElement('customComposite'))).toEqual({ sx: 1, sy: 1, cspc2: 32 });
  });

  it('still refuses the genuinely unmirrorable bodies', () => {
    // Upstream forbids flip outright for these four (OTAElm.java:191-192,
    // WattmeterElm.java:282-283, ThreePhaseMotorElm, MotorProtectionSwitchElm)
    // and a two-post part has Swap instead.
    for (const kind of ['ota', 'wattmeter', 'threePhaseMotor', 'motorProtectionSwitch']) {
      expect(canMirror(toolElement(kind)), kind).toBe(false);
    }
    expect(canMirror(toolElement('resistor'))).toBe(false);
  });
});

describe('newly supported harness kinds', () => {
  // The kinds this port added to the harness set after the first eighteen,
  // each with the count of output-tagged pins its default layout carries,
  // read off the upstream class's setupPins. The analog mux's Z and the bus
  // splitter route through resistors rather than voltage sources, so they
  // carry no output tag at all.
  const NEW_KIND_OUTPUTS: readonly [kind: string, outputs: number][] = [
    ['analogMux', 0],
    ['busSplitter', 0],
    ['busTransceiver', 0],
    ['counter2', 5],  // Q3..Q0 plus RCO
    ['fullAdder', 5],  // S3..S0 plus C
    ['halfAdder', 2],  // S and C
    ['monostable', 2],  // Q and /Q
    ['pisoShift', 1],  // Q8 under the default New Behavior flag
    ['rom', 4],  // D3..D0
    ['seqGen', 1],  // Q
    ['sevenSegDecoder', 7],  // segments a..g
    ['sipoShift', 8],  // Q0..Q7
    ['sram', 4],  // D3..D0
    ['timeDelayRelay', 0],
  ];

  for (const [kind, outputs] of NEW_KIND_OUTPUTS) {
    it(`gives ${kind} a pin table aligned with its posts and tagged outputs`, () => {
      const e = toolElement(kind);
      const pins = CHIP_PINS.get(kind)!(e);
      // Pin i is post i: chipPosts maps the same table the harness reads, so
      // a drift between the table and the def's post geometry would strand
      // harness leads in space.
      expect(pins.length).toBe(postsOf(e).length);
      expect(pins.length).toBe(postCountOf(e));
      expect(pins.filter((p) => p.output).length).toBe(outputs);
    });
  }
});

describe('Create Test gating on the widened set', () => {
  it('offers the command for newly supported chips like counter2 and halfAdder', () => {
    for (const kind of ['counter2', 'halfAdder', 'sevenSegDecoder', 'sram', 'rom']) {
      const e = toolElement(kind);
      expect(selectHarnessChip([e], [e.id])).toBe(e);
    }
  });

  it('still refuses a VCVS, its controlled-source siblings and the delay buffer', () => {
    for (const kind of ['vcvs', 'vccs', 'cccs', 'ccvs', 'delayBuffer']) {
      const e = toolElement(kind);
      expect(selectHarnessChip([e], [e.id])).toBeNull();
    }
  });

  it('builds a counter2 harness from its pin metadata: five outputs, nine inputs', () => {
    const e = toolElement('counter2');
    const pins = chipPinsOf(e)!;
    const posts = postsOf(e);
    const placed = createTestHarness(
      pins.map((p, i) => ({
        side: p.side,
        output: p.output ?? false,
        post: posts[i],
        busWidth: p.busWidth,
        busZ: p.busZ,
      })),
      GRID_SIZE,
    );
    expect(placed.filter((p) => p.kind === 'logicOutput')).toHaveLength(5);
    expect(placed.filter((p) => p.kind === 'logicInput')).toHaveLength(9);
    for (const p of placed) {
      expect(posts).toContainEqual({ x: p.x1, y: p.y1 });
    }
  });
});
