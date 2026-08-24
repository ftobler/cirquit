/** Test helper for the denied-storage browser shape (review finding M1): with
 *  site data blocked, reading `globalThis.localStorage` itself throws
 *  SecurityError before any getItem/setItem guard can run. Swapping in a
 *  throwing getter models that without a real browser. Returns the restore
 *  function; call it in a finally block or afterEach. */

export function denyGlobalStorage(): () => void {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: The operation is insecure.');
    },
  });
  return () => {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  };
}
