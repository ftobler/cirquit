/** A hand-rolled JSON-Schema subset, deliberately small: the web bundle has
 *  six runtime dependencies and the MCP SDK takes raw JSON Schema, so a plain
 *  object costs nothing to serialise and nothing to ship. Unknown object keys
 *  are refused by default so a typo in agent arguments names itself instead
 *  of silently doing nothing. */

import type { ArgSchema } from './types';

export interface SchemaError {
  /** Dotted/bracketed path to the offending value: `params.resistance`. */
  path: string;
  message: string;
}

const show = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

function typeMatches(schema: ArgSchema, value: unknown): boolean {
  if ('anyOf' in schema) return schema.anyOf.some((child) => typeMatches(child, value));
  switch (schema.type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
  }
}

/** Validate a value against `schema`. The root path is `args`, so a caller
 *  can put the message straight in front of a user or an agent. */
export function validateArgs(schema: ArgSchema, value: unknown): SchemaError | null {
  return check(schema, value, 'args');
}

function check(schema: ArgSchema, value: unknown, path: string): SchemaError | null {
  if ('anyOf' in schema) {
    let first: SchemaError | null = null;
    for (const branch of schema.anyOf) {
      const err = check(branch, value, path);
      if (err === null) return null;
      first ??= err;
    }
    return first ?? { path, message: `${path}: no anyOf branch accepted the value` };
  }
  if (!typeMatches(schema, value)) {
    return { path, message: `${path}: expected ${schema.type}, got ${show(value)}` };
  }
  switch (schema.type) {
    case 'object': {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (Object.prototype.hasOwnProperty.call(schema.properties, key)) continue;
        if (schema.additionalProperties === true) continue;
        if (typeof schema.additionalProperties === 'object') {
          const err = check(schema.additionalProperties, record[key], `${path}.${key}`);
          if (err) return err;
          continue;
        }
        return { path: `${path}.${key}`, message: `${path}.${key}: unknown property` };
      }
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
          return { path: `${path}.${key}`, message: `${path}.${key}: required property missing` };
        }
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        const err = check(child, record[key], `${path}.${key}`);
        if (err) return err;
      }
      return null;
    }
    case 'array': {
      const arr = value as unknown[];
      if (schema.minItems !== undefined && arr.length < schema.minItems) {
        return {
          path,
          message: `${path}: expected at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`,
        };
      }
      if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
        return { path, message: `${path}: expected at most ${schema.maxItems} items` };
      }
      for (let i = 0; i < arr.length; i++) {
        const err = check(schema.items, arr[i], `${path}[${i}]`);
        if (err) return err;
      }
      return null;
    }
    case 'number':
    case 'integer': {
      const n = value as number;
      if (schema.minimum !== undefined && n < schema.minimum) {
        return { path, message: `${path}: must be >= ${schema.minimum}` };
      }
      if (schema.maximum !== undefined && n > schema.maximum) {
        return { path, message: `${path}: must be <= ${schema.maximum}` };
      }
      return null;
    }
    case 'string': {
      const text = value as string;
      if (schema.enum !== undefined && !schema.enum.includes(text)) {
        return { path, message: `${path}: expected one of ${schema.enum.join(', ')}` };
      }
      if (schema.minLength !== undefined && text.length < schema.minLength) {
        return { path, message: `${path}: must be at least ${schema.minLength} characters` };
      }
      if (schema.maxLength !== undefined && text.length > schema.maxLength) {
        return { path, message: `${path}: must be at most ${schema.maxLength} characters` };
      }
      return null;
    }
    case 'boolean':
    case 'null':
      return null;
  }
}

/** Meta-validation of a schema itself: the registry test runs this over every
 *  command so a malformed definition cannot reach an MCP tool listing. */
export function validateSchema(schema: ArgSchema, path = 'args'): SchemaError[] {
  if ('anyOf' in schema) {
    if (schema.anyOf.length === 0) {
      return [{ path, message: `${path}: anyOf must not be empty` }];
    }
    return schema.anyOf.flatMap((child, i) => validateSchema(child, `${path}|${i}`));
  }
  switch (schema.type) {
    case 'object': {
      const errors: SchemaError[] = [];
      const names = Object.keys(schema.properties);
      for (const [key, child] of Object.entries(schema.properties)) {
        errors.push(...validateSchema(child, `${path}.${key}`));
      }
      for (const key of schema.required ?? []) {
        if (!names.includes(key)) {
          errors.push({ path: `${path}.${key}`, message: `${path}.${key}: required property is not declared` });
        }
      }
      if (
        schema.additionalProperties !== undefined &&
        typeof schema.additionalProperties !== 'boolean'
      ) {
        errors.push(...validateSchema(schema.additionalProperties, `${path}.*`));
      }
      return errors;
    }
    case 'array': {
      const errors = validateSchema(schema.items, `${path}[]`);
      if (schema.minItems !== undefined && schema.minItems < 0) {
        errors.push({ path, message: `${path}: minItems must be >= 0` });
      }
      if (
        schema.minItems !== undefined &&
        schema.maxItems !== undefined &&
        schema.minItems > schema.maxItems
      ) {
        errors.push({ path, message: `${path}: minItems exceeds maxItems` });
      }
      return errors;
    }
    case 'number':
    case 'integer':
      if (
        schema.minimum !== undefined &&
        schema.maximum !== undefined &&
        schema.minimum > schema.maximum
      ) {
        return [{ path, message: `${path}: minimum exceeds maximum` }];
      }
      return [];
    case 'string': {
      const errors: SchemaError[] = [];
      if (schema.enum !== undefined && schema.enum.length === 0) {
        errors.push({ path, message: `${path}: enum must not be empty` });
      }
      if (
        schema.minLength !== undefined &&
        schema.maxLength !== undefined &&
        schema.minLength > schema.maxLength
      ) {
        errors.push({ path, message: `${path}: minLength exceeds maxLength` });
      }
      return errors;
    }
    case 'boolean':
    case 'null':
      return [];
    default:
      return [{ path, message: `${path}: unknown schema type` }];
  }
}
