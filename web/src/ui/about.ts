/** Pure helpers for the About dialog, split out so the logic is node-testable
 *  like the other ui/ modules (AGENTS.md: nothing testable belongs inside a
 *  React component). */

/** The download URL for the static-deployment zip, relative to where the app
 *  itself is served. Vite's BASE_URL always carries a trailing slash (`/` on
 *  the dev server, `/cirquit/` on Pages), and CI drops the zip next to the
 *  built app, so joining the two is the whole construction. The link 404s on
 *  the dev server, where no zip exists; that is expected, only the deployed
 *  site carries the file. */
export function staticDeploymentUrl(baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}static-deployment.zip`;
}
