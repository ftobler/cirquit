/** File > Toggle Full Screen. Upstream tracks the state in a static flag
 *  (Graphics.isFullScreen) flipped around vendor-prefixed request calls
 *  (Graphics.java:188-216); the DOM already exposes the truth as
 *  document.fullscreenElement, so this reads that instead of mirroring it.
 *  The narrow structural type keeps the command testable without a DOM: node
 *  implements none of the Fullscreen API, and jsdom follows. */

export interface FullScreenDocument {
  fullscreenElement: Element | null;
  /** Both calls are feature-checked: an engine without unprefixed fullscreen
   *  support must degrade to a no-op instead of throwing on entry. */
  documentElement: { requestFullscreen?(): unknown };
  exitFullscreen?(): unknown;
  /** Where the deferred re-fit listens for the transition; present on every
   *  real document. */
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface ToggleOutcome {
  /** True when the document ends up full screen, or intends to and cannot. */
  entering: boolean;
  /** True when a browser call was actually issued, so its transition events
   *  are worth waiting for. */
  initiated: boolean;
}

function initiate(doc: FullScreenDocument): ToggleOutcome {
  const entering = doc.fullscreenElement === null;
  const request: (() => unknown) | undefined = entering
    ? doc.documentElement.requestFullscreen
    : doc.exitFullscreen;
  if (request === undefined) return { entering, initiated: false };
  // A denied request rejects; swallow it so the console never sees an
  // unhandled rejection (upstream merely flips its flag, Graphics.java:190).
  Promise.resolve(request()).catch(() => undefined);
  return { entering, initiated: true };
}

/** Toggle the browser's full-screen surface on the document element. True
 *  when the document is entering full screen, false when leaving it or unable
 *  to change. */
export function toggleFullScreen(doc: FullScreenDocument): boolean {
  return initiate(doc).entering;
}

/** The whole command, CommandManager.java:305-311: toggle the surface, then
 *  re-centre the circuit. The synchronous fit stays for the paths where no
 *  event ever comes, a denied request chief among them; when the transition
 *  does land it fires fullscreenchange, and the one-shot listener re-fits
 *  against the post-transition viewport, which the first fit cannot know.
 *  fullscreenerror clears the listeners too, so a denial never leaves a stray
 *  fit waiting to fire on some later manual F11. */
export function runFullScreenToggle(doc: FullScreenDocument, center: () => void): boolean {
  const { entering, initiated } = initiate(doc);
  if (initiated) {
    const settled = () => {
      doc.removeEventListener('fullscreenchange', settled);
      doc.removeEventListener('fullscreenerror', settled);
      center();
    };
    doc.addEventListener('fullscreenchange', settled);
    doc.addEventListener('fullscreenerror', settled);
  }
  center();
  return entering;
}
