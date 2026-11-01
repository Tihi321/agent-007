/**
 * A hand-written JSON-Schema subset (S17.1, I25a): type, enum, min, max, length limits, pattern, items, properties, required,
 * `additionalProperties` (false or a schema) and `x-ui` hints. No dependency. The SAME descriptors drive the browser forms
 * (S18.2: `GET /api/schema`), so a form can never offer something the validator refuses.
 *
 * Pure: no imports.
 */

export type SchemaType = "object" | "string" | "integer" | "number" | "boolean" | "array";

export interface UiHint {
  label?: string;
  help?: string;
  /** `text | textarea | number | toggle | select | list | path | url | tags | readonly`. */
  widget?: string;
  group?: string;
  /** For a `list` of objects: which property names the entry in the list. */
  titleKey?: string;
  placeholder?: string;
  /** Marks a field the form must never show (kept for completeness). */
  hidden?: boolean;
}

export interface Schema {
  type?: SchemaType;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  /** Default false for objects: an unknown key is an error. A schema validates every extra value (a map). */
  additionalProperties?: boolean | Schema;
  description?: string;
  default?: unknown;
  "x-ui"?: UiHint;
}

export interface SchemaIssue {
  path: string;
  message: string;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates `value` against `schema`. Returns every issue found (empty = valid). Keys beginning with `_` are comments and are ignored. */
export function validate(schema: Schema, value: unknown, path = ""): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const at = path === "" ? "(root)" : path;
  const add = (message: string): void => void issues.push({ path: at, message });

  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) {
        add(`expected an object, got ${typeName(value)}`);
        return issues;
      }
      const props = schema.properties ?? {};
      for (const key of schema.required ?? []) if (!(key in value)) issues.push({ path: join(path, key), message: "is required" });
      for (const [key, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) {
          issues.push({ path: join(path, key), message: "is not an allowed key" });
          continue;
        }
        const sub = props[key];
        if (key.startsWith("_") && !sub) continue; // "_comment" keys are notes, as in config.json
        if (sub) issues.push(...validate(sub, v, join(path, key)));
        else if (schema.additionalProperties === true) continue;
        else if (isSchema(schema.additionalProperties)) issues.push(...validate(schema.additionalProperties, v, join(path, key)));
        else issues.push({ path: join(path, key), message: "is not a known setting" });
      }
      return issues;
    }
    case "array": {
      if (!Array.isArray(value)) {
        add(`expected a list, got ${typeName(value)}`);
        return issues;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) add(`needs at least ${schema.minItems} entries`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`allows at most ${schema.maxItems} entries`);
      if (schema.items) value.forEach((v, i) => issues.push(...validate(schema.items as Schema, v, `${at === "(root)" ? "" : at}[${i}]`)));
      return issues;
    }
    case "string": {
      if (typeof value !== "string") {
        add(`expected text, got ${typeName(value)}`);
        return issues;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) add(`needs at least ${schema.minLength} characters`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) add(`allows at most ${schema.maxLength} characters`);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) add(`does not match the required format`);
      break;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        add(`expected a number, got ${typeName(value)}`);
        return issues;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) add("expected a whole number");
      if (schema.minimum !== undefined && value < schema.minimum) add(`must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) add(`must be at most ${schema.maximum}`);
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") add(`expected true or false, got ${typeName(value)}`);
      break;
    }
    default:
      break;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean)) add(`must be one of: ${schema.enum.join(", ")}`);
  return issues;
}

function isSchema(v: unknown): v is Schema {
  return typeof v === "object" && v !== null;
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** Every dotted key path of the schema's object properties (arrays and maps end the walk). For the "no security row is writable" test. */
export function schemaPaths(schema: Schema, prefix = ""): string[] {
  const out: string[] = [];
  if (schema.type === "object" && schema.properties) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      const p = join(prefix, k);
      out.push(p);
      out.push(...schemaPaths(sub, p));
    }
    if (isSchema(schema.additionalProperties)) out.push(...schemaPaths(schema.additionalProperties, join(prefix, "*")));
  } else if (schema.type === "array" && schema.items) {
    out.push(...schemaPaths(schema.items, `${prefix}[]`));
  }
  return out;
}

/** The default value a schema describes, for a new list entry in a form. Objects fill their properties' defaults. */
export function defaultFor(schema: Schema): unknown {
  if (schema.default !== undefined) return structuredClone(schema.default);
  switch (schema.type) {
    case "object": {
      const o: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(schema.properties ?? {})) {
        if ((schema.required ?? []).includes(k) || sub.default !== undefined) o[k] = defaultFor(sub);
      }
      return o;
    }
    case "array":
      return [];
    case "string":
      return "";
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}
