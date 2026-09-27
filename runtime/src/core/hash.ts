import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted by code point, no insignificant
 * whitespace. Used for identity hashes, so it rejects values that JSON would
 * silently drop or change (undefined, functions, non-finite numbers, sparse
 * array holes).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        // Index explicitly: `map` skips holes, which would drop elements or emit invalid JSON.
        for (let index = 0; index < value.length; index++) {
          if (!Object.hasOwn(value, index)) throw new TypeError(`${path}[${index}]: sparse array hole`);
          items.push(serialize(value[index], `${path}[${index}]`));
        }
        return `[${items.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path}: only plain objects are allowed`);
      }
      const entries = Object.keys(value)
        .sort()
        .map((key) => {
          const item = (value as Record<string, unknown>)[key];
          return `${JSON.stringify(key)}:${serialize(item, `${path}.${key}`)}`;
        });
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`${path}: unsupported ${typeof value} value`);
  }
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Recursively freezes plain data so resolved configuration cannot drift within an episode. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
