import { parseUnits } from "viem";

export const round = (value: number, decimals = 6): number => {
  if (!Number.isFinite(value)) throw new Error("Non-finite number");
  const n = Number(value.toFixed(decimals));
  return Object.is(n, -0) ? 0 : n;
};
export const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
export function priceE8(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) throw new Error("Price must be positive and finite");
  const value = parseUnits(price.toFixed(8), 8);
  if (value === 0n || value > 18446744073709551615n) throw new Error("Price is outside uint64 E8 range");
  return value;
}
