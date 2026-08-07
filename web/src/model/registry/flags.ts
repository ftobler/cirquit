/**
 * File-format flag bits, named after the upstream class that defines each one.
 *
 * The bits are part of the interchange format, so a value here is a contract:
 * changing a meaning breaks files saved by earlier builds, exactly as it would
 * break files saved by upstream. Each element definition imports the subset it
 * reads or writes.
 */

/** Shared by the asymmetric parts: for the op-amp it swaps the two input leads
 *  ("Swap Inputs" upstream), for the transistor it swaps which side of the
 *  base-to-output axis the collector and emitter hang off ("Swap E/C"
 *  upstream). Same bit, meaning per type. transform.ts flips it on
 *  rotate/mirror. */
export const FLAG_SWAP = 1;
export const OPAMP_SWAP = FLAG_SWAP;   // OpAmpElm.java:28
export const OPAMP_SMALL = 2;          // OpAmpElm.java:29
export const OPAMP_GAIN = 8;           // OpAmpElm.java:31
export const TRANSISTOR_FLIP = FLAG_SWAP; // TransistorElm.java:44
export const MOSFET_PNP = 1;            // MosfetElm.java:35
export const MOSFET_FLIP = 8;           // MosfetElm.java:37
export const POT_SHOW_VALUES = 1;      // PotElm.java:32
export const POT_FLIP = 2;             // PotElm.java:33
export const POT_FLIP_OFFSET = 4;      // PotElm.java:34
export const SWITCH2_CENTER_OFF = 1;   // Switch2Elm.java:30
export const SWITCH_LABEL = 4;         // SwitchElm.java:33, inherited by Switch2Elm
export const VOLTAGE_SHOW_VOLTAGE = 16; // VoltageElm.java:32
/** Load-time only: a legacy cosine, cleared on load (VoltageElm.java:29, 80-83). */
export const VOLTAGE_COS = 2;
/** Whether a pulse line's duty token predates the configurable duty cycle
 *  (VoltageElm.java:30, 85-88). The writer sets it so an edited duty survives
 *  a reload. */
export const VOLTAGE_PULSE_DUTY = 4;
export const PROBE_SHOW_VOLTAGE = 1;   // ProbeElm.java:30
export const PROBE_CIRCLE = 2;         // ProbeElm.java:31
export const CAP_BACK_EULER = 2;       // CapacitorElm.java:32
export const IND_BACK_EULER = 2;       // Inductor.java:23, same bit as the capacitor's flag
export const CAP_RESISTANCE = 4;       // CapacitorElm.java:33
/** Marks free text as one escaped token rather than the old space-joined
 *  form. Same bit and same meaning on both text-bearing types
 *  (TextElm.java:38, LabeledNodeElm.java:30); their writers always set it. */
export const FLAG_ESCAPE = 4;
