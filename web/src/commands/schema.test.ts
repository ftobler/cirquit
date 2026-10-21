/** The hand-rolled JSON-Schema subset: the argument door's only type check. */

import { describe, expect, it } from 'vitest';
import { validateArgs, validateSchema } from './schema';
import type { ArgSchema } from './types';

const object = (
  properties: Record<string, ArgSchema>,
  required?: string[],
): ArgSchema => ({ type: 'object', properties, required, additionalProperties: false });

describe('validateArgs', () => {
  it('accepts each scalar type', () => {
    expect(validateArgs({ type: 'number' }, 1.5)).toBeNull();
    expect(validateArgs({ type: 'integer' }, 3)).toBeNull();
    expect(validateArgs({ type: 'string' }, 'x')).toBeNull();
    expect(validateArgs({ type: 'boolean' }, false)).toBeNull();
    expect(validateArgs({ type: 'null' }, null)).toBeNull();
  });

  it('rejects a wrong type with a path', () => {
    const schema = object({ id: { type: 'integer' } });
    expect(validateArgs(schema, { id: 'seven' })).toEqual({
      path: 'args.id',
      message: 'args.id: expected integer, got "seven"',
    });
  });

  it('reports a missing required property by path', () => {
    const schema = object({ kind: { type: 'string' } }, ['kind']);
    expect(validateArgs(schema, {})).toEqual({
      path: 'args.kind',
      message: 'args.kind: required property missing',
    });
  });

  it('rejects unknown extra keys so a typo surfaces', () => {
    const schema = object({ resistance: { type: 'number' } });
    expect(validateArgs(schema, { resistance: 1, resistnace: 2 })).toEqual({
      path: 'args.resistnace',
      message: 'args.resistnace: unknown property',
    });
  });

  it('accepts an explicit open object for the element params family', () => {
    const schema: ArgSchema = {
      type: 'object',
      properties: {},
      additionalProperties: { type: 'number' },
    };
    expect(validateArgs(schema, { resistance: 1000, capacitance: 1e-5 })).toBeNull();
    expect(validateArgs(schema, { resistance: 'x' })).toEqual({
      path: 'args.resistance',
      message: 'args.resistance: expected number, got "x"',
    });
  });

  it('checks enum membership', () => {
    const schema: ArgSchema = { type: 'string', enum: ['voltage', 'current'] };
    expect(validateArgs(schema, 'voltage')).toBeNull();
    expect(validateArgs(schema, 'power')).toEqual({
      path: 'args',
      message: 'args: expected one of voltage, current',
    });
  });

  it('checks numeric bounds', () => {
    const schema: ArgSchema = { type: 'number', minimum: 0, maximum: 10 };
    expect(validateArgs(schema, 10)).toBeNull();
    expect(validateArgs(schema, -1)).toEqual({ path: 'args', message: 'args: must be >= 0' });
    expect(validateArgs(schema, 11)).toEqual({ path: 'args', message: 'args: must be <= 10' });
  });

  it('walks nested arrays of tuples and reports the tuple path', () => {
    const schema: ArgSchema = {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          minItems: 2,
        },
      },
      required: ['points'],
      additionalProperties: false,
    };
    expect(validateArgs(schema, { points: [[0, 0], [64, 0]] })).toBeNull();
    expect(validateArgs(schema, { points: [[0, 0], [64]] })).toEqual({
      path: 'args.points[1]',
      message: 'args.points[1]: expected at least 2 items',
    });
    expect(validateArgs(schema, { points: [[0, 0], [64, 'x']] })).toEqual({
      path: 'args.points[1][1]',
      message: 'args.points[1][1]: expected number, got "x"',
    });
  });

  it('accepts either branch of an anyOf', () => {
    const schema: ArgSchema = { anyOf: [{ type: 'number' }, { type: 'null' }] };
    expect(validateArgs(schema, 2)).toBeNull();
    expect(validateArgs(schema, null)).toBeNull();
    expect(validateArgs(schema, 'x')?.path).toBe('args');
  });
});

describe('validateSchema', () => {
  it('accepts every schema the registry declares by construction', () => {
    const schema = object(
      {
        id: { type: 'integer' },
        value: { type: 'string', enum: ['a', 'b'] },
        at: object({ x: { type: 'number' } }, ['x']),
      },
      ['id'],
    );
    expect(validateSchema(schema)).toEqual([]);
  });

  it('names a required property that is not declared', () => {
    const schema = object({ id: { type: 'integer' } }, ['missing']);
    expect(validateSchema(schema)).toEqual([
      {
        path: 'args.missing',
        message: 'args.missing: required property is not declared',
      },
    ]);
  });

  it('rejects an empty enum and an inverted range', () => {
    expect(validateSchema({ type: 'string', enum: [] })).toEqual([
      { path: 'args', message: 'args: enum must not be empty' },
    ]);
    expect(validateSchema({ type: 'number', minimum: 2, maximum: 1 })).toEqual([
      { path: 'args', message: 'args: minimum exceeds maximum' },
    ]);
  });
});
