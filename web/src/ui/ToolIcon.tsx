/** One button's static icon: the tool's own symbol painted once per mount,
 *  theme flip or settings change (the custom colours and IEC symbols flow in),
 *  so each canvas paints once, never on every React render. Shared by the
 *  toolbox grid and the context-menu palette, which both show the real symbol. */

import { useEffect, useRef } from 'react';
import type { SimSettings } from '../model/types';
import { renderToolIcon, TOOL_ICON_SIZE } from '../render/toolIcon';

/** Oversampling factor for the icon's backing canvas, on top of the real
 *  device pixel ratio. These are hairline vector strokes at a 24 px icon
 *  size, so even a DPR-1 display aliases visibly when the backing store
 *  matches the CSS size 1:1; quadrupling it supersamples down to a crisp
 *  square in every theme and at every zoom level. */
const ICON_OVERSAMPLE = 4;

export function ToolIcon({
  toolId,
  dark,
  settings,
  className = 'tool-icon',
}: {
  toolId: string;
  dark: boolean;
  settings: SimSettings;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const pixelRatio = (window.devicePixelRatio || 1) * ICON_OVERSAMPLE;
    const size = TOOL_ICON_SIZE * pixelRatio;
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    renderToolIcon(toolId, canvas, dark, settings, pixelRatio);
  }, [toolId, dark, settings]);
  return (
    <canvas
      ref={ref}
      width={TOOL_ICON_SIZE}
      height={TOOL_ICON_SIZE}
      className={className}
      aria-hidden="true"
    />
  );
}
