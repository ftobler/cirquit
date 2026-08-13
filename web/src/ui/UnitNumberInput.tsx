/** Text input for a physical value, used by the settings fields and the
 *  unit-ful element edit rows. Accepts unit suffixes, shorthand and scientific
 *  notation through parseUnits, keeps an invalid draft on screen with an error
 *  instead of dropping the edit, and re-formats to the stored value once the
 *  user blurs. The shown value uses the ASCII formatter so a micro value reads
 *  back as `5u` and round-trips parseUnits, never the µ glyph. */

import { useEffect, useId, useState } from 'react';
import { formatUnitsAscii, parseUnits } from '../model/units';

interface Props {
  label: string;
  value: number;
  /** Reject zero or negative parsed values (the timestep must stay positive). */
  positive?: boolean;
  /** Reject drafts outside [min, max] and clamp the committed value into it. */
  min?: number;
  max?: number;
  /** Round the committed value to a whole number (the digit-count fields). */
  integer?: boolean;
  onCommit: (n: number) => void;
  onFocus?: () => void;
}

export function UnitNumberInput({
  label,
  value,
  positive,
  min,
  max,
  integer,
  onCommit,
  onFocus,
}: Props) {
  // The box shows just the value, unit-less ("4.7k"), with the unit carried by
  // the field label, exactly like upstream's edit dialog. parseUnits would
  // reject a rendered "4.7k Ω" anyway (space before unit, Ω not a suffix).
  const [draft, setDraft] = useState(() => formatUnitsAscii(value));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState(false);
  // The error message needs a stable id so the input can point its
  // aria-describedby at it and a screen reader hears what is wrong.
  const errorId = useId();

  // An outside change (undo, selection switch, file load) must refresh the
  // box, but the value flowing back from our own commit must not fight the
  // keystroke the user is mid-way through, so the sync only runs while blurred.
  useEffect(() => {
    if (!focused) setDraft(formatUnitsAscii(value));
  }, [value, focused]);

  // A draft is valid when it parses to a finite number inside every constraint
  // the field carries; an unparseable or out-of-range draft shows the error
  // and commits nothing, so the store keeps the last good value.
  function valid(n: number): boolean {
    if (!Number.isFinite(n)) return false;
    if (positive && n <= 0) return false;
    if (min !== undefined && n < min) return false;
    if (max !== undefined && n > max) return false;
    return true;
  }

  // Clamp and round on commit, not on every keystroke, so a draft in progress
  // ("4.7" heading to "4.7k") never flashes an error. The caller stores a
  // value that is always inside the field's range and whole when `integer`.
  function commit(n: number): number {
    if (min !== undefined && n < min) n = min;
    if (max !== undefined && n > max) n = max;
    return integer ? Math.round(n) : n;
  }

  return (
    <>
      <label className="field">
        <span>{label}</span>
        <input
          type="text"
          value={draft}
          aria-invalid={error}
          aria-describedby={error ? errorId : undefined}
          onFocus={() => {
            setFocused(true);
            setError(false);
            onFocus?.();
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = parseUnits(e.target.value);
            if (valid(n)) {
              setError(false);
              onCommit(commit(n));
            } else {
              setError(true);
            }
          }}
          onBlur={() => {
            setFocused(false);
            setError(false);
            setDraft(formatUnitsAscii(value));
          }}
        />
      </label>
      {error && (
        <div id={errorId} className="problem" role="alert">
          Invalid value
        </div>
      )}
    </>
  );
}
