import { keccak256, stringToHex } from "viem";
import { resolve } from "node:path";
import { writeImmutable } from "./paths.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical JSON value");
}

export function hashBundle(value: unknown): `0x${string}` {
  return keccak256(stringToHex(canonicalJson(value)));
}

export async function saveBundle(value: unknown, directory: string): Promise<`0x${string}`> {
  const hash = hashBundle(value);
  await writeImmutable(resolve(directory, `${hash}.json`), canonicalJson(value));
  return hash;
}
