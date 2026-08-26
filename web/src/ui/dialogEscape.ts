/** Layered Escape across stacked dialogs: each mounted Dialog claims one
 *  entry on mount, releases it on cleanup, and only the newest claim may
 *  answer a press, so closing the Device Model Editor over the element
 *  properties dialog leaves the properties dialog for the next press instead
 *  of cancelling both at once. Pure module state, node-tested like
 *  `dialogEnter.ts`; the stack lives here rather than in the store because it
 *  tracks mount order and nothing renders from it. */

/** One mounted dialog's hold on the Escape key: what closing means right now,
 *  plus the release bookkeeping. Created only through [`claimEscape`]. */
export interface EscapeClaim {
  /** The claimant's close action. Routed through a getter-style thunk by the
   *  Dialog so an inline `onClose` or a toggling `onEscape` stays live
   *  without re-claiming, which would reorder the stack on every render. */
  close: () => void;
  /** Set once released, so a second release can never drop someone else's
   *  slot and a stale handle can never own again. */
  released: boolean;
}

const escapeStack: EscapeClaim[] = [];

/** Pushes a claim onto the stack and hands it back. Pair every call with one
 *  [`releaseEscape`] in the effect's cleanup; StrictMode's double effects are
 *  symmetric push/pop pairs, so they settle one claim per live mount. */
export function claimEscape(close: () => void): EscapeClaim {
  const claim: EscapeClaim = { close, released: false };
  escapeStack.push(claim);
  return claim;
}

/** True only while `claim` is the newest unreleased entry: stacked dialogs
 *  answer Escape top-first and the ones below wait for the next press. */
export function ownsEscape(claim: EscapeClaim): boolean {
  return escapeStack[escapeStack.length - 1] === claim && !claim.released;
}

/** Drops exactly this claim, wherever it now sits, so an out-of-order
 *  unmount under siblings promotes the one below instead of clearing the
 *  whole stack. Releasing twice changes nothing. */
export function releaseEscape(claim: EscapeClaim): void {
  if (claim.released) return;
  claim.released = true;
  const at = escapeStack.indexOf(claim);
  if (at !== -1) escapeStack.splice(at, 1);
}

/** How many claims are held, so tests can assert none leaked: one live
 *  claim too many would swallow Escape app wide. */
export function escapeClaimCount(): number {
  return escapeStack.length;
}
