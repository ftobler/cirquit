/** File > Toggle Full Screen. Upstream tracks the state in a static flag
 *  (Graphics.isFullScreen) flipped around vendor-prefixed request calls
 *  (Graphics.java:188-216); the DOM already exposes the truth as
 *  document.fullscreenElement, so this reads that instead of mirroring it.
 *  The narrow structural type keeps the command testable without a DOM: node
 *  implements none of the Fullscreen API, and jsdom follows. */

export interface FullScreenDocument {
  fullscreenElement: Element | null;
  documentElement: { requestFullscreen(): unknown };
  exitFullscreen(): unknown;
}

/** Toggle the browser's full-screen surface on the document element. True
 *  when the document is entering full screen, false when leaving it. */
export function toggleFullScreen(doc: FullScreenDocument): boolean {
  if (doc.fullscreenElement !== null) {
    void doc.exitFullscreen();
    return false;
  }
  void doc.documentElement.requestFullscreen();
  return true;
}

/** The whole command, CommandManager.java:305-311: toggle the surface, then
 *  re-centre the circuit into whatever viewport is left over. */
export function runFullScreenToggle(doc: FullScreenDocument, center: () => void): boolean {
  const entering = toggleFullScreen(doc);
  center();
  return entering;
}
