import { describe, expect, it } from 'vitest';
import { staticDeploymentUrl } from './about';

describe('staticDeploymentUrl', () => {
  it('joins a sub-path base to the zip name', () => {
    expect(staticDeploymentUrl('/cirquit/')).toBe('/cirquit/static-deployment.zip');
  });

  it('joins the root base to the zip name', () => {
    expect(staticDeploymentUrl('/')).toBe('/static-deployment.zip');
  });

  it('normalises a base without a trailing slash', () => {
    expect(staticDeploymentUrl('/cirquit')).toBe('/cirquit/static-deployment.zip');
  });
});
