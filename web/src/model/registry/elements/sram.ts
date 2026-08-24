/**
 * The static RAM (SRAMElm.java, dump 413): a chip whose address and data bits
 * ride on the west and east sides, with active-low WE and OE at the top. The
 * file line carries `addressBits dataBits` after the optional high voltage,
 * then the stored contents as runs of consecutive addresses: `addr val val
 * ... -1 addr val ... -1 ... -2` (SRAMElm.java:55-70). Upstream's text
 * `dump()` drops the sizes and the contents, so this port's writer restores
 * them (the same quirk fix as the thermistor's position token).
 *
 * The shared pin, parse and dump helpers serve the ROM too (dump 436), which
 * is the same memory chip without the WE pin; `rom.ts` builds its def on
 * them.
 */

import {
  CHIP_BIT_ORDER_BUS,
  chipBitOrderFlags,
  chipBitOrderParam,
  chipBodyRect,
  chipCommonTokens,
  chipDumpFlags,
  chipPosts,
  drawChip,
  normalizeChipBits,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The contents dialog's hex display (SRAMElm.java:30). Display-only: the
 *  token stream is decimal either way, so the bit just round-trips. */
export const SRAM_HEX_DISPLAY = 4;
/** Restore the load-time contents on reset (SRAMElm.java:36). */
export const SRAM_RELOAD_ON_RESET = 2;

/** The bit widths, floored like the engine: truncated and clamped to the
 *  2..16 the edit dialog allows (SRAMElm.java:228-241, sram.rs:79). */
export function normalizeSramBits(value: number): number {
  return normalizeChipBits(value, 2, 16);
}

function sramAddressBits(e: CircuitElement): number {
  return normalizeSramBits(e.params.addressBits ?? 4);
}

function sramDataBits(e: CircuitElement): number {
  return normalizeSramBits(e.params.dataBits ?? 4);
}

/** Bus bit order (upstream BIT_ORDER_BUS, XML attribute `bo="2"`): the
 *  address bank and the data bank each collapse onto one row of their side. */
export function memoryBus(e: CircuitElement): boolean {
  return e.params.bitOrder === 2 || (e.flags & CHIP_BIT_ORDER_BUS) !== 0;
}

/** `sizeY = max(addrY, dataY) + 1` (SRAMElm.java:110), with both bank heights
 *  1 in bus mode. */
export function memorySizeY(e: CircuitElement): number {
  if (memoryBus(e)) return 2;
  return Math.max(sramAddressBits(e), sramDataBits(e)) + 1;
}

/** The pin table, from `setupPins` (SRAMElm.java:106-123, ROMElm.java:37-58):
 *  the active-low WE (SRAM only) and OE at the top, then makeBitPins runs of
 *  address pins down the west and data pins down the east, both MSB first.
 *  The data pins are `output` for the post count and the draw only: they are
 *  bidirectional electrically, a role the engine models, and nothing is saved
 *  to the file. */
export function memoryPins(e: CircuitElement, hasWe: boolean): ChipPinDef[] {
  const ab = sramAddressBits(e);
  const db = sramDataBits(e);
  const bus = memoryBus(e);
  const sizeY = memorySizeY(e);
  const pins: ChipPinDef[] = [];
  if (hasWe) {
    pins.push({ side: 'W', pos: 0, text: 'WE', lineOver: true });
    pins.push({ side: 'E', pos: 0, text: 'OE', lineOver: true });
  } else {
    // The ROM's OE is the single west control pin, at the top-left
    // (ROMElm.java:47-49).
    pins.push({ side: 'W', pos: 0, text: 'OE', lineOver: true });
  }
  // makeBitPins reversed, MSB first: the list runs A_{ab-1}..A0 down the west
  // and D_{db-1}..D0 down the east, the MSB on the top row (SRAMElm.java:
  // 120-121). In bus mode each bank collapses onto row sizeY - bankY (both
  // bank heights are 1), every pin carrying its logical bit as its tag.
  const addrY = bus ? 1 : ab;
  const dataY = bus ? 1 : db;
  for (let j = 0; j < ab; j++) {
    pins.push({
      side: 'W',
      pos: sizeY - addrY + (bus ? 0 : j),
      text: bus ? 'A' : `A${ab - 1 - j}`,
      ...(bus ? { busWidth: ab, busZ: ab - 1 - j } : {}),
    });
  }
  for (let j = 0; j < db; j++) {
    pins.push({
      side: 'E',
      pos: sizeY - dataY + (bus ? 0 : j),
      text: bus ? 'D' : `D${db - 1 - j}`,
      output: true,
      ...(bus ? { busWidth: db, busZ: db - 1 - j } : {}),
    });
  }
  return pins;
}

/** Reads the contents runs starting at `t[start]` into the flat `addr{i}` /
 *  `val{i}` param pairs, in stream order. Grouping consecutive addresses on
 *  dump recovers the runs byte-exactly, and the engine's last-wins map insert
 *  over a pair list matches `map.put` over overlapping runs (SRAMElm.java:
 *  58-69). */
function readContentsRuns(t: string[], e: CircuitElement, start: number): void {
  let k = 0;
  let i = start;
  while (i < t.length) {
    const addr = Number(t[i]);
    if (!Number.isFinite(addr) || addr < 0) break;
    i++;
    if (i >= t.length) break;
    e.params[`addr${k}`] = addr;
    e.params[`val${k}`] = Number(t[i]);
    i++;
    k++;
    let next = addr;
    while (i < t.length) {
      const v = Number(t[i]);
      if (!Number.isFinite(v) || v < 0) {
        // Consume the run's -1 terminator so the next run-start read lands on
        // the following token (SRAMElm.java:66-69).
        i++;
        break;
      }
      next += 1;
      e.params[`addr${k}`] = next;
      e.params[`val${k}`] = v;
      i++;
      k++;
    }
  }
}

/** Reads the common chip tokens, the two width tokens and the contents runs.
 *  The layout is the same with or without the WE pin (ROMElm.java:28-31). */
export function memoryParse(t: string[], e: CircuitElement): void {
  const i = chipCommonTokens(t, e, false);
  const ab = Number(t[i]);
  if (t[i] !== undefined && Number.isFinite(ab)) e.params.addressBits = normalizeSramBits(ab);
  const db = Number(t[i + 1]);
  if (t[i + 1] !== undefined && Number.isFinite(db)) e.params.dataBits = normalizeSramBits(db);
  readContentsRuns(t, e, i + 2);
  chipBitOrderParam(e);
}

/** The flat `addr{i}` / `val{i}` params as an ordered pair list. The order is
 *  the stream order the file used, which is also the order `memoryDump`
 *  regroups runs from and the contents editor presents. */
export function memoryPairs(e: CircuitElement): [number, number][] {
  const pairs: [number, number][] = [];
  let k = 0;
  while (e.params[`addr${k}`] !== undefined) {
    pairs.push([e.params[`addr${k}`], e.params[`val${k}`] ?? 0]);
    k++;
  }
  return pairs;
}

/** Writes the common chip tokens, the two width tokens and the contents
 *  runs. Upstream's own `dump()` writes none of the memory's tokens, so this
 *  writer restores all of them: a save must not shrink the part to a blank
 *  4x4. */
export function memoryDump(e: CircuitElement): (string | number)[] {
  const out: (string | number)[] = [];
  const hv = e.params.highVoltage;
  if (hv !== undefined && hv !== 5) out.push(hv);
  out.push(e.params.addressBits ?? 4);
  out.push(e.params.dataBits ?? 4);
  const pairs = memoryPairs(e);
  // Regroup the flat pairs into runs of consecutive addresses.
  let i = 0;
  while (i < pairs.length) {
    out.push(pairs[i][0]);
    let expect = pairs[i][0];
    while (i < pairs.length && pairs[i][0] === expect) {
      out.push(pairs[i][1]);
      expect += 1;
      i += 1;
    }
    out.push(-1);
  }
  if (pairs.length > 0) out.push(-2);
  return out;
}

function drawSram(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, memorySizeY(e), memoryPins(e, true));
}

export const SRAM_DEF: ElementDef = {
  kind: 'sram',
  label: 'static RAM',
  category: 'Logic',
  dumpCode: '413',
  postCount: 10,  // WE + OE + 2*4 bits at the default
  posts: (e) => chipPosts(e, 2, memorySizeY(e), memoryPins(e, true)),
  bodyRect: (e) => chipBodyRect(e, 2, memorySizeY(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 3,  // the chip spans (sizeX + 1) * 32
  defaults: { addressBits: 4, dataBits: 4, highVoltage: 5 },
  parse: (t, e) => memoryParse(t, e),
  dump: memoryDump,
  dumpFlags: (e) => chipBitOrderFlags(e, chipDumpFlags(e)),
  fields: [
    { name: 'addressBits', label: '# of Address Bits', min: 2, max: 16, integer: true },
    { name: 'dataBits', label: '# of Data Bits', min: 2, max: 16, integer: true },
    { name: 'contents', label: 'Contents', type: 'contents' },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    { name: 'hexDisplay', label: 'Hex Display', type: 'bool', flag: SRAM_HEX_DISPLAY },
    // The Load Contents From File row (SRAMElm.java:154, SRAMLoadFile
    // .java:31-48). No value rides the field: the picked bytes are encoded
    // into the contents run and committed through setMemoryContents, so
    // nothing here reaches params or the file line. The ROM has no such row.
    { name: 'loadFile', label: 'Load Contents From File', type: 'file', fileLoad: 'binary' },
    {
      name: 'reloadOnReset',
      label: 'Restore Contents on Reset',
      type: 'bool',
      flag: SRAM_RELOAD_ON_RESET,
    },
  ],
  draw: drawSram,
};
