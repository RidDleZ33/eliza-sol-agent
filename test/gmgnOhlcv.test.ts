import { describe, test, expect, afterEach } from "bun:test";
import { fetchGmgnOhlcv } from "../src/services/priceAction/gmgnOhlcv.ts";

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

function mockFetch(json: any, expectedUrl = "https://openapi.gmgn.ai/v1/market/token_kline") {
  globalThis.fetch = async (url: any, init?: any) => {
    return {
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as Response;
  };
}

describe("gmgnOhlcv", () => {
  test("parses kline array to bars (ts in seconds converted to ms)", async () => {
    mockFetch({
      data: [
        [1791000000, 1.0, 1.1, 0.9, 1.05, 1000],
        [1791000060, 1.05, 1.2, 1.0, 1.15, 2000],
      ],
    });
    const result = await fetchGmgnOhlcv("mint", "1m", 60);
    expect(result.bars).not.toBeNull();
    expect(result.bars!.length).toBe(2);
    expect(result.bars![0].t).toBe(1791000000000);
    expect(result.bars![0].o).toBe(1.0);
    expect(result.bars![1].c).toBe(1.15);
    expect(result.reason).toBe("ok");
  });

  test("parses object-form candles", async () => {
    mockFetch({
      data: [
        { timestamp: 1791000000, open: 1.0, high: 1.1, low: 0.9, close: 1.05, volume: 1000 },
        { timestamp: 1791000060, open: 1.05, high: 1.2, low: 1.0, close: 1.15, volume: 2000 },
      ],
    });
    const result = await fetchGmgnOhlcv("mint", "1m", 60);
    expect(result.bars).not.toBeNull();
    expect(result.bars!.length).toBe(2);
    expect(result.bars![0].t).toBe(1791000000000);
    expect(result.bars![0].o).toBe(1.0);
    expect(result.bars![1].c).toBe(1.15);
    expect(result.reason).toBe("ok");
  });

  test("empty data returns null bars", async () => {
    mockFetch({ data: [] });
    const result = await fetchGmgnOhlcv("mint");
    expect(result.bars).toBeNull();
    expect(result.reason).toBe("empty_data");
  });

  test("403 returns null bars", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      text: async () => "blocked",
    } as Response);
    const result = await fetchGmgnOhlcv("mint");
    expect(result.bars).toBeNull();
    expect(result.reason).toBe("http_403");
  });

  test("non-finite bars filtered", async () => {
    mockFetch({
      data: [
        [1791000000, NaN, 1.1, 0.9, 1.05, 1000],
        [1791000060, 1.05, 1.2, 1.0, 1.15, 2000],
      ],
    });
    const result = await fetchGmgnOhlcv("mint");
    expect(result.bars!.length).toBe(1);
  });
});
