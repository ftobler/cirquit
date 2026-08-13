/** Brand styling helpers for the menubar, pure and node-testable like the
 *  other ui/ modules. */

/** The menubar brand text's CSS `background`, a horizontal sweep from the
 *  voltage scale's positive colour to its negative one. The two come from
 *  `makeTheme(true, { positiveColor, negativeColor })`: the menubar stays dark
 *  in both canvas themes, so the dark palette is forced and the user's custom
 *  Colour settings flow straight through. */
export function brandGradient(theme: { positive: string; negative: string }): string {
  return `linear-gradient(90deg, ${theme.positive}, ${theme.negative})`;
}
