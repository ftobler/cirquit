import { useEffect, useRef } from 'react';
import { useStore } from '../../state/store';

/** Live store state behind a ref, so animation and pointer handlers can read
 *  it without putting React on the 60 Hz render path. */
export function useStoreRef() {
  const stateRef = useRef(useStore.getState());
  useEffect(() => useStore.subscribe((s) => (stateRef.current = s)), []);
  return stateRef;
}
