// canonical-json-v1 (backlog B03, design doc 09 "Hashing", acceptance AT-44).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  CanonicalJsonError,
  canonicalDigest,
  canonicalJson,
  compareCodePoints,
  parseJson,
  sha256Hex,
} from "@design-loom/config";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures", "design");

interface Vector {
  id: string;
  input: unknown;
  canonical: string;
  sha256: string;
}

// The fixture file is parsed with the strict parser itself, so vectors also exercise parsing.
const vectorFile = parseJson(readFileSync(join(FIXTURES, "canonical-json-v1-vectors.json"), "utf8")) as unknown as {
  vectors: Vector[];
};

describe("design package vectors", () => {
  test("the fixture contains the expected vectors", () => {
    assert.deepEqual(
      vectorFile.vectors.map((v) => v.id),
      ["scalar-key-order", "nested-array-order", "integer-boundaries", "string-escaping", "no-unicode-normalization"],
    );
  });

  for (const vector of vectorFile.vectors) {
    test(`${vector.id}: exact canonical string and SHA-256`, () => {
      assert.equal(canonicalJson(vector.input), vector.canonical);
      assert.equal(canonicalDigest(vector.input), vector.sha256);
      assert.equal(sha256Hex(new TextEncoder().encode(vector.canonical)), vector.sha256);
    });
  }
});

describe("compareCodePoints", () => {
  test("orders by code point, not UTF-16 code unit", () => {
    // U+FF61 < U+1F600 by code point, but the default sort puts the emoji's surrogate pair first.
    assert.ok(compareCodePoints("｡", "\u{1f600}") < 0);
    assert.deepEqual(["\u{1f600}", "｡"].sort(), ["\u{1f600}", "｡"]);
    assert.deepEqual(["\u{1f600}", "｡"].sort(compareCodePoints), ["｡", "\u{1f600}"]);
  });

  test("puts a shorter prefix first and treats equal strings as equal", () => {
    assert.ok(compareCodePoints("ab", "abc") < 0);
    assert.ok(compareCodePoints("abc", "ab") > 0);
    assert.equal(compareCodePoints("é", "é"), 0);
    assert.equal(compareCodePoints("", ""), 0);
  });
});

describe("serialization", () => {
  test("sorts nested keys, keeps array order and emits no whitespace", () => {
    assert.equal(canonicalJson({ b: [3, { y: 1, x: 2 }], a: "z" }), '{"a":"z","b":[3,{"x":2,"y":1}]}');
  });

  test("escapes only quote, backslash and control characters", () => {
    assert.equal(canonicalJson("\u007f /é\u001f"), '"\u007f /é\\u001f"');
  });

  test("normalizes negative zero and accepts integral values", () => {
    assert.equal(canonicalJson([-0, 1.0, 1e2]), "[0,1,100]");
  });

  test("keeps __proto__ as an ordinary key", () => {
    const parsed = parseJson('{"__proto__":{"polluted":true},"a":1}');
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(canonicalJson(parsed), '{"__proto__":{"polluted":true},"a":1}');
  });

  test("is stable across a parse round trip", () => {
    const value = { z: ["\u{1f600}", null, true], a: { "｡": -12, "": "" } };
    const once = canonicalJson(value);
    assert.equal(canonicalJson(parseJson(once)), once);
  });

  const invalid: Array<[string, unknown]> = [
    ["fractional number", 1.5],
    ["number above the safe range", 2 ** 53],
    ["number below the safe range", -(2 ** 53)],
    ["infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["lone surrogate in a key", { "\ud800": 1 }],
    ["lone surrogate in a value", "\udfff"],
    ["undefined", undefined],
    ["undefined object value", { a: undefined }],
    ["bigint", 1n],
    ["function", () => 1],
    ["date", new Date(0)],
    ["map", new Map()],
    ["class instance", new (class Example {})()],
    ["symbol key", { [Symbol("s")]: 1 }],
    ["sparse array", Object.assign(new Array<number>(3), { 0: 1, 2: 3 })],
  ];
  for (const [name, value] of invalid) {
    test(`rejects ${name}`, () => {
      assert.throws(() => canonicalJson(value), CanonicalJsonError);
    });
  }

  test("rejects circular structures", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assert.throws(() => canonicalJson(cycle), CanonicalJsonError);
  });

  test("allows the same object twice when it isn't a cycle", () => {
    const shared = { a: 1 };
    assert.equal(canonicalJson([shared, shared]), '[{"a":1},{"a":1}]');
  });
});

describe("strict parsing", () => {
  const invalid: Array<[string, string]> = [
    ["duplicate keys", '{"id":1,"id":2}'],
    ["unpaired high surrogate escape", '"\\ud800"'],
    ["unpaired low surrogate escape", '"\\udfff"'],
    ["leading byte-order mark", '﻿{"a":1}'],
    ["trailing comma", "[1,2,]"],
    ["single quotes", "{'a':1}"],
    ["comment", '{"a":1 /* note */}'],
    ["trailing content", '{"a":1} x'],
    ["unescaped control character", '"a\u0001b"'],
    ["invalid escape", '"\\x41"'],
    ["leading zero", "01"],
    ["NaN literal", "NaN"],
    ["empty input", ""],
    ["unterminated string", '"abc'],
    ["raw unpaired surrogate in the text", '"a\ud800b"'],
    ["fractional number", "1.5"],
    ["fraction too small for a float", "1.0000000000000000001"],
    ["huge exponent", "1e400"],
    ["tiny fraction by exponent", "5e-1"],
    ["integer above the safe range", "9007199254740992"],
    ["integer far above the safe range", "9007199254740993"],
    ["integer below the safe range", "-9007199254740992"],
    ["lone minus", "-"],
    ["missing fraction digits", "1."],
    ["missing integer digits", ".5"],
    ["plus sign", "+1"],
  ];
  for (const [name, text] of invalid) {
    test(`rejects ${name}`, () => {
      assert.throws(() => parseJson(text), CanonicalJsonError);
    });
  }

  test("accepts number literals that denote exact safe integers", () => {
    const cases: Array<[string, number]> = [
      ["0", 0],
      ["-0", 0],
      ["-0.0", 0],
      ["1.0", 1],
      ["1e2", 100],
      ["10e-1", 1],
      ["100E-2", 1],
      ["9007199254740991", 9007199254740991],
      ["-9007199254740991", -9007199254740991],
      ["9.007199254740991e15", 9007199254740991],
      ["0e999999", 0],
    ];
    for (const [literal, expected] of cases) {
      assert.equal(parseJson(literal), expected, literal);
    }
  });

  test("parses many numbers in linear time", () => {
    const count = 200_000;
    const text = `[${Array.from({ length: count }, (_, i) => i).join(",")}]`;
    const started = performance.now();
    const parsed = parseJson(text) as number[];
    const elapsed = performance.now() - started;
    assert.equal(parsed.length, count);
    assert.equal(parsed[count - 1], count - 1);
    // Quadratic copying took seconds at this size; linear parsing takes milliseconds.
    assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
  });

  test("rejects one huge number literal in linear time", () => {
    // Interior zeros made a /0+$/ trailing-zero scan quadratic: seconds for a 100 KB literal.
    const literal = `1${"0".repeat(200_000)}1`;
    const started = performance.now();
    assert.throws(() => parseJson(literal), CanonicalJsonError);
    assert.throws(() => parseJson(`[${literal}.5]`), CanonicalJsonError);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
  });

  test("combines escaped surrogate pairs into one code point", () => {
    assert.equal(parseJson('"\\ud83d\\ude00"'), "\u{1f600}");
  });

  test("rejects nesting deeper than the limit", () => {
    assert.throws(() => parseJson(`${"[".repeat(1100)}${"]".repeat(1100)}`), CanonicalJsonError);
  });
});
