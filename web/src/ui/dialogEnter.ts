/** Shared keydown guards for dialog fields, kept pure so they are testable
 *  without a DOM (the dialogs themselves stay untested under the node env). */

/** True when a field's keydown is the Enter that should commit the dialog:
 *  an IME composition's confirmation keystroke also reports key 'Enter', and
 *  committing mid-composition would save half-converted text. Upstream's
 *  keyCode-based check skipped these events incidentally (keyCode 229,
 *  UIManager.java:1084); the port asks the event directly instead. */
export function isCommitEnter(ev: {
  key: string;
  nativeEvent: { isComposing?: boolean };
}): boolean {
  return ev.key === 'Enter' && !(ev.nativeEvent.isComposing ?? false);
}
