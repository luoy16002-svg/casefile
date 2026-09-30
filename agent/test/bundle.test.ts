import { describe, expect, it } from "vitest";
import { canonicalJson, hashBundle } from "../src/bundle.js";

describe("canonical JSON", () => {
  it("sorts keys recursively and preserves array order, UTF-8 and JSON numbers", () => {
    expect(canonicalJson({ z: [{ b: 2, a: "é" }, 1], a: -0 })).toBe('{"a":0,"z":[{"a":"é","b":2},1]}');
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });
  it("matches the independently checked cast keccak vector", () => {
    expect(hashBundle({ b: 2, a: 1 })).toBe("0xb8ffb64722137f4b100665a52e3c943f8066e8ab8ba3b427e6f4b404defd82b0");
  });
  it.each([NaN, Infinity, undefined, 1n, new Date(0)])("rejects non-JSON value %s", value => {
    expect(() => canonicalJson(value)).toThrow();
  });
});
