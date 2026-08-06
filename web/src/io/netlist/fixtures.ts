import { fileURLToPath } from 'node:url';
import type { CircuitElement } from '../../model/types';

export const CIRCUITS_DIR = fileURLToPath(new URL('../../../public/circuits', import.meta.url));

/** A circuit in the original format, exercising several element types. */
export const SAMPLE = `$ 1 0.000005 10.20027730826997 50 5 43 5e-11
r 176 80 384 80 0 10
s 384 80 448 80 0 1 false
w 176 80 176 352 0
c 384 352 176 352 0 0.000015 -9.86 -10
l 384 80 384 352 0 1 0.03 0
v 448 352 448 80 0 0 40 5 0 0 0.5
g 176 352 176 384 0
o 4 64 0 4099 20 0.05 0 2 4 3
38 3 0 0.000001 0.000101 Capacitance
`;

/** Drops the session-unique id so two loads of the same circuit compare. */
export const dropId = (e: CircuitElement) => {
  const { id, ...rest } = e;
  void id;
  return rest;
};
