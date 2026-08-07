/** Clipboard writes shared by the Export As Link and Export As Text dialogs.
 *  DOM-bound, so not unit tested, exactly like fileIO. */

/** Copies `text` to the system clipboard. In a secure context the Clipboard
 *  API is used; elsewhere (or on rejection) the text is shown in a prompt the
 *  user can copy by hand. Returns whether the Clipboard API path succeeded, so
 *  a caller can confirm the write happened rather than the fallback. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the manual fallback
    }
  }
  window.prompt('Copy to clipboard:', text);
  return false;
}
