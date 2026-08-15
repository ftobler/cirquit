/** Pure helpers for the About dialog, split out so the logic is node-testable
 *  like the other ui/ modules (AGENTS.md: nothing testable belongs inside a
 *  React component). */

/** The zip the About dialog offers for download. It is named for the project
 *  rather than for what it is, because the name is what the user ends up with
 *  in their downloads folder; the CI step that builds it uses the same name. */
export const STATIC_DEPLOYMENT_ZIP = 'ftobler-cirquit.zip';

/** The download URL for the static-deployment zip, relative to where the app
 *  itself is served. Vite's BASE_URL always carries a trailing slash (`/` on
 *  the dev server, `/cirquit/` on Pages), and CI drops the zip next to the
 *  built app, so joining the two is the whole construction. The link 404s on
 *  the dev server, where no zip exists; that is expected, only the deployed
 *  site carries the file. */
export function staticDeploymentUrl(baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${STATIC_DEPLOYMENT_ZIP}`;
}
