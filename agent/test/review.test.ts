import { describe, expect, it } from "vitest";
import { detectClose, reviewCandles } from "../src/review.js";
import { ledgerCase, fixture } from "./helpers.js";
import type { Candle } from "../src/types.js";

const candle = (time: number, low = 99, high = 101, close = 100): Candle => [time, low, high, close, close, 1];
describe("paper review", () => {
  it("detects long stop, target and neither before horizon", () => {
    expect(detectClose(ledgerCase(), [candle(3600, 94, 101)], 3600)).toEqual({ reason: "Stop", exitE8: 9500000000n });
    expect(detectClose(ledgerCase(), [candle(3600, 99, 111)], 3600)).toEqual({ reason: "Target", exitE8: 11000000000n });
    expect(detectClose(ledgerCase(), [candle(3600)], 3600)).toBeNull();
  });
  it("detects mirrored short stops and targets", () => {
    const c = ledgerCase({ side: 2, stopE8: 10500000000n, targetE8: 9000000000n });
    expect(detectClose(c, [candle(3600, 99, 106)], 3600)).toEqual({ reason: "Stop", exitE8: c.stopE8 });
    expect(detectClose(c, [candle(3600, 89, 101)], 3600)).toEqual({ reason: "Target", exitE8: c.targetE8 });
  });
  it.each([1, 2])("takes the conservative stop when side %s crosses both in one candle", side => {
    const c = ledgerCase({ side, stopE8: side === 1 ? 9500000000n : 10500000000n, targetE8: side === 1 ? 11000000000n : 9000000000n });
    expect(detectClose(c, [candle(3600, 89, 111)], 3600)).toEqual({ reason: "Stop", exitE8: c.stopE8 });
  });
  it("walks candles chronologically and stops at the first trigger", () => {
    expect(detectClose(ledgerCase(), [candle(7200, 94, 101), candle(3600, 99, 111)], 7200)).toMatchObject({ reason: "Target" });
  });
  it("closes at horizon with latest close; flats ignore price triggers", () => {
    expect(detectClose(ledgerCase(), [candle(3600), candle(7200, 99, 103, 102)], 10800)).toEqual({ reason: "Horizon", exitE8: 10200000000n });
    expect(detectClose(ledgerCase({ side: 0, stopE8: 0n, targetE8: 0n }), [candle(3600, 1, 1000)], 10800)).toMatchObject({ reason: "Horizon" });
    expect(detectClose(ledgerCase({ side: 0 }), [candle(3600)], 10799)).toBeNull();
  });
  it("ignores pre-entry candles, future candles and already closed cases", () => {
    expect(detectClose(ledgerCase({ openedAt: 3601n }), [candle(3600, 1, 200), candle(7200)], 7200)).toBeNull();
    expect(detectClose(ledgerCase(), [candle(7200, 1, 200)], 3600)).toBeNull();
    expect(detectClose(ledgerCase({ reason: 1 }), [candle(3600, 1, 200)], 10800)).toBeNull();
  });
  it("can use the opening hour's latest close at Horizon after a local clock warp", () => {
    expect(detectClose(ledgerCase({ openedAt: 3601n }), [candle(3600, 1, 200, 102)], 10801))
      .toEqual({ reason: "Horizon", exitE8: 10200000000n });
  });
  it("leaves a case open without complete review evidence", () => {
    const e = fixture().exhibits[0]!;
    expect(reviewCandles([{ ...e, status: "unavailable", data: null }])).toBeNull();
    expect(reviewCandles([{ ...e, data: [candle(3600), candle(10800)] }])).toBeNull();
    expect(detectClose(ledgerCase(), [], 10800)).toBeNull();
  });
});
