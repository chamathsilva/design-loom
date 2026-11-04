/**
 * canonical-json-v1: the framework's byte-exact JSON form for hashing (design doc 09, "Hashing").
 *
 * - Parsing rejects duplicate keys, invalid Unicode, anything that isn't strict JSON, and numbers
 *   that aren't exact safe integers (no silent rounding: "1.0000000000000000001" is rejected).
 * - Object keys are sorted by Unicode scalar value (code point), never by UTF-16 code unit or locale.
 * - Output has no insignificant whitespace, no BOM and no final newline, encoded as UTF-8.
 * - Only `"` and `\` plus control characters are escaped; everything else is emitted literally.
 * - Numbers must be finite integers within ±(2^53 − 1); −0 becomes 0.
 *
 * This is a framework-specific contract. It does not claim compatibility with RFC 8785 or any
 * other canonicalization standard.
 */

import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  override name = "CanonicalJsonError";
}

const MAX_DEPTH = 1000;

/** Sticky (y) so it matches at lastIndex without copying the rest of the input. */
const NUMBER_PATTERN = /(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?/y;

/** Compares strings by Unicode scalar value sequence; a shorter prefix sorts first. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(j) ?? 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

/** Defines an own data property, so keys such as "__proto__" stay ordinary data. */
function setOwn(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Strict JSON parser (RFC 8259) that also enforces canonical-json-v1 input rules. */
export function parseJson(text: string): JsonValue {
  let pos = 0;

  const fail = (message: string): never => {
    throw new CanonicalJsonError(`${message} at offset ${pos}`);
  };
  const skipWhitespace = (): void => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      pos++;
    }
  };
  const expect = (literal: string): void => {
    if (!text.startsWith(literal, pos)) fail(`expected "${literal}"`);
    pos += literal.length;
  };

  const parseString = (): string => {
    pos++; // opening quote
    let out = "";
    let segmentStart = pos;
    while (true) {
      if (pos >= text.length) fail("unterminated string");
      const c = text.charCodeAt(pos);
      if (c === 0x22) {
        out += text.slice(segmentStart, pos);
        pos++;
        break;
      }
      if (c < 0x20) fail("unescaped control character in string");
      if (c !== 0x5c) {
        pos++;
        continue;
      }
      out += text.slice(segmentStart, pos);
      const escapeChar = text[pos + 1];
      pos += 2;
      switch (escapeChar) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          pos += 4;
          break;
        }
        default:
          fail("invalid escape sequence");
      }
      segmentStart = pos;
    }
    if (!out.isWellFormed()) fail("string contains an unpaired surrogate");
    return out;
  };

  /**
   * Parses a number literal exactly, without going through a lossy float. Only exact safe
   * integers are accepted: "1.0", "1e2" and "-0.0" denote integers, while "1.5", "1e400" and
   * "1.0000000000000000001" are rejected instead of being rounded.
   */
  const parseNumber = (): number => {
    NUMBER_PATTERN.lastIndex = pos;
    const match = NUMBER_PATTERN.exec(text);
    if (match === null) return fail("invalid number");
    const [literal, sign = "", whole = "", fraction = "", exponentText = "0"] = match;
    pos += literal.length;

    const digits = (whole + fraction).replace(/^0+/, "");
    if (digits === "") return 0;
    const exponent = Number(exponentText);
    // Scan back for trailing zeros; a /0+$/ regex retries at every interior zero, which is quadratic.
    let end = digits.length;
    while (digits.charCodeAt(end - 1) === 48) end--;
    const significant = digits.slice(0, end);
    const trailingZeros = digits.length - end;
    // Power of ten applied to `significant`, which has no trailing zeros.
    const scale = exponent - fraction.length + trailingZeros;
    if (!Number.isSafeInteger(scale) || scale < 0) return fail(`number is not an integer: ${literal}`);
    if (significant.length + scale > 16) return fail(`number outside the safe integer range: ${literal}`);

    const magnitude = BigInt(significant) * 10n ** BigInt(scale);
    if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) {
      return fail(`number outside the safe integer range: ${literal}`);
    }
    return sign === "-" ? -Number(magnitude) : Number(magnitude);
  };

  const parseValue = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) fail("nesting too deep");
    skipWhitespace();
    const c = text[pos];
    if (c === "{") {
      pos++;
      const result: Record<string, JsonValue> = {};
      const seen = new Set<string>();
      skipWhitespace();
      if (text[pos] === "}") {
        pos++;
        return result;
      }
      while (true) {
        skipWhitespace();
        if (text[pos] !== '"') fail("expected object key");
        const key = parseString();
        if (seen.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        seen.add(key);
        skipWhitespace();
        expect(":");
        setOwn(result, key, parseValue(depth + 1));
        skipWhitespace();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        expect("}");
        return result;
      }
    }
    if (c === "[") {
      pos++;
      const result: JsonValue[] = [];
      skipWhitespace();
      if (text[pos] === "]") {
        pos++;
        return result;
      }
      while (true) {
        result.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        expect("]");
        return result;
      }
    }
    if (c === '"') return parseString();
    if (c === "t") {
      expect("true");
      return true;
    }
    if (c === "f") {
      expect("false");
      return false;
    }
    if (c === "n") {
      expect("null");
      return null;
    }
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return parseNumber();
    return fail("unexpected character");
  };

  if (text.charCodeAt(0) === 0xfeff) fail("byte-order mark is not allowed");
  const value = parseValue(0);
  skipWhitespace();
  if (pos !== text.length) fail("unexpected trailing content");
  return value;
}

function escapeString(value: string): string {
  if (!value.isWellFormed()) throw new CanonicalJsonError("string contains an unpaired surrogate");
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new CanonicalJsonError("numbers must be finite");
  if (!Number.isInteger(value)) throw new CanonicalJsonError(`numbers must be integers: ${value}`);
  if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`number outside the safe integer range: ${value}`);
  return Object.is(value, -0) ? "0" : String(value);
}

/** Serializes a JSON value to its canonical-json-v1 string. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();

  const serialize = (current: unknown, depth: number): string => {
    if (depth > MAX_DEPTH) throw new CanonicalJsonError("nesting too deep");
    if (current === null) return "null";
    if (current === true) return "true";
    if (current === false) return "false";
    if (typeof current === "number") return serializeNumber(current);
    if (typeof current === "string") return escapeString(current);
    if (typeof current !== "object") throw new CanonicalJsonError(`unsupported value of type ${typeof current}`);
    if (ancestors.has(current)) throw new CanonicalJsonError("circular structure");

    ancestors.add(current);
    let out: string;
    if (Array.isArray(current)) {
      const items: string[] = [];
      for (let i = 0; i < current.length; i++) {
        if (!(i in current)) throw new CanonicalJsonError("sparse arrays are not allowed");
        items.push(serialize(current[i], depth + 1));
      }
      out = `[${items.join(",")}]`;
    } else {
      const proto = Object.getPrototypeOf(current);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError("only plain objects are allowed");
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new CanonicalJsonError("symbol keys are not allowed");
      }
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).sort(compareCodePoints);
      const members = keys.map((key) => {
        if (record[key] === undefined) throw new CanonicalJsonError(`undefined value for key ${JSON.stringify(key)}`);
        return `${escapeString(key)}:${serialize(record[key], depth + 1)}`;
      });
      out = `{${members.join(",")}}`;
    }
    ancestors.delete(current);
    return out;
  };

  return serialize(value, 0);
}

/** canonical-json-v1 bytes: the canonical string encoded as UTF-8. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/** Lower-case hex SHA-256 of the canonical-json-v1 bytes. */
export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

/** Lower-case hex SHA-256 of raw bytes, for stored file contents. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
