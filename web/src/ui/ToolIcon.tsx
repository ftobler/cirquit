/** One button's static icon: the tool's own symbol painted once per mount,
 *  theme flip or settings change (the custom colours and IEC symbols flow in),
 *  so each canvas paints once, never on every React render. Shared by the
 *  toolbox grid and the context-menu palette, which both show the real symbol. */

import { useEffect, useRef } from 'react';
import type { SimSettings } from '../model/types';
import { renderToolIcon, TOOL_ICON_SIZE } from '../render/toolIcon';

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
    renderToolIcon(toolId, canvas, dark, settings);
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
