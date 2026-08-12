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
/** The triode's electrode-side bit. Bit 1 like the shared FLAG_SWAP, but its
 *  own meaning (TriodeElm.java:26): it negates the `dsign`-derived electrode
 *  side. transform.ts toggles it on rotate/mirror in the cases upstream's
 *  flipX/flipY/flipXY override (TriodeElm.java:251-268). */
export const TRIODE_FLIP = 1;            // TriodeElm.java:26
/** A fresh triode tracks its electrode side with the drag direction; a loaded
 *  file may not carry the bit (TriodeElm.java:35). transform.ts treats a part
 *  without it as legacy and toggles FLAG_FLIP where a dsign-driven part would
 *  not need it (TriodeElm.java:253-255, :261-262). */
export const TRIODE_DSIGN_FIX = 2;       // TriodeElm.java:27
export const MOSFET_PNP = 1;            // MosfetElm.java:35
export const MOSFET_FLIP = 8;           // MosfetElm.java:37
export const RELAY_SWAP_COIL = 1;       // RelayElm.java:39
export const RELAY_SHOW_BOX = 2;        // RelayElm.java:40
export const RELAY_BOTH_SIDES_COIL = 4; // RelayElm.java:41
export const RELAY_FLIP = 8;            // RelayElm.java:42
export const RELAY_PULLDOWN = 16;       // RelayElm.java:43
export const RELAY_CONTACT_NORMALLY_CLOSED = 2; // RelayContactElm.java:40
export const RELAY_CONTACT_IEC = 4;     // RelayContactElm.java:41
export const POT_SHOW_VALUES = 1;      // PotElm.java:32
export const POT_FLIP = 2;             // PotElm.java:33
export const POT_FLIP_OFFSET = 4;      // PotElm.java:34
export const SWITCH2_CENTER_OFF = 1;   // Switch2Elm.java:30
export const SWITCH_LABEL = 4;         // SwitchElm.java:33, inherited by Switch2Elm
export const SWITCH_IEC = 2;           // SwitchElm.java:32 FLAG_IEC
/** Bit 1 of a logic input turns the third (mid) position on, making the
 *  input cycle 0..2 instead of flipping 0/1 (LogicInputElm.java:26). */
export const LOGIC_INPUT_TERNARY = 1;  // LogicInputElm.java:26
export const RAIL_CLOCK = 1;           // RailElm.java:37 FLAG_CLOCK
/** The data input replays its sample buffer from the start once it runs past
 *  the end (DataInputElm.java:43, :123-126). */
export const DATA_INPUT_REPEAT = 256;  // DataInputElm.java:43 FLAG_REPEAT
/** Voltage text beside an AC rail, inherited from VoltageElm (VoltageElm.java:36). */
export const RAIL_SHOW_VOLTAGE = 64;   // FLAG_SHOW_VOLTAGE_RAIL
export const VOLTAGE_SHOW_VOLTAGE = 16; // VoltageElm.java:32
/** Load-time only: a legacy cosine, cleared on load (VoltageElm.java:29, 80-83). */
export const VOLTAGE_COS = 2;
/** Whether a pulse line's duty token predates the configurable duty cycle
 *  (VoltageElm.java:30, 85-88). The writer sets it so an edited duty survives
 *  a reload. */
export const VOLTAGE_PULSE_DUTY = 4;
/** A DC source draws the circled +/− symbol instead of the two-plate battery
 *  (VoltageElm.java:31). Meaningless on a non-DC waveform, where the circle
 *  is always drawn. */
export const VOLTAGE_CIRCLE_SYMBOL = 8;
export const PROBE_SHOW_VOLTAGE = 1;   // ProbeElm.java:30
export const PROBE_CIRCLE = 2;         // ProbeElm.java:31
export const OUTPUT_SHOW_VOLTAGE = 1;  // OutputElm.java:28
export const OUTPUT_FIXED = 2;         // OutputElm.java:29
/** The Show Current and Show Voltage checkboxes of a wire (WireElm.java:35-36,
 *  :160-175): each draws the live value beside the wire, current as `|I|` in
 *  amps and voltage in volts, joined with a space. Upstream's bus-value
 *  toggles, FLAG_SHOW_BUS_VALUE = 4 and FLAG_SHOW_BUS_VALUE_HEX = 8, are not
 *  ported: this build has no bus wire, so only the two value bits exist. */
export const WIRE_SHOW_CURRENT = 1;    // WireElm.java:35
export const WIRE_SHOW_VOLTAGE = 2;    // WireElm.java:36
export const CAP_BACK_EULER = 2;       // CapacitorElm.java:32
export const IND_BACK_EULER = 2;       // Inductor.java:23, same bit as the capacitor's flag
export const CAP_RESISTANCE = 4;       // CapacitorElm.java:33
export const TRANSFORMER_REVERSE = 4;  // TransformerElm.java:32 FLAG_REVERSE
export const TRANSFORMER_VERTICAL = 8; // TransformerElm.java:33 FLAG_VERTICAL
export const TRANSFORMER_FLIP = 16;    // TransformerElm.java:34 FLAG_FLIP
/** The tapped and custom transformers share bit 1 for FLAG_FLIP
 *  (TappedTransformerElm.java:27, CustomTransformerElm.java:29). */
export const TAPPED_FLIP = 1;
/** Marks free text as one escaped token rather than the old space-joined
 *  form. Same bit and same meaning on both text-bearing types
 *  (TextElm.java:38, LabeledNodeElm.java:30); their writers always set it. */
export const FLAG_ESCAPE = 4;
/** A labeled node marked "Internal Node": its name is a private net of the
 *  circuit, not a pin to expose when the circuit becomes a subcircuit
 *  (LabeledNodeElm.java:31, :76). */
export const LABELED_NODE_INTERNAL = 1;

/** The gates share the three FlagBits from GateElm.java:26-28: small body
 *  (half-size geometry), hysteresis on the inputs, and a bubble on every
 *  input. */
export const GATE_SMALL = 1;           // GateElm.java:26
export const GATE_SCHMITT = 2;         // GateElm.java:27
export const GATE_INVERT_INPUTS = 4;   // GateElm.java:28
/** The tri-state buffer's control-side flag; bit 1, like the asymmetric
 *  parts' shared FLAG_SWAP, but with its own meaning (TriStateElm.java:37).
 *  transform.ts mirrors it unconditionally, because the control offset is
 *  absolute rather than dsign-driven. */
export const TRI_STATE_FLIP = 1;       // TriStateElm.java:37
