// JSONL sidecar writer
// Writes one JSON object per line to data/tape/ticks-YYYY-MM-DD.jsonl
// Gated by TAPE_JSONL=1 environment variable

import { getDb } from "./db";
import { recordError } from "./pollers/dexscreener";

const fs = require("fs");
const path = require("path");

let jsonlEnabled = false;
let jsonlStream = null;
let jsonlDate = "";

export function initJsonl(): void {
  jsonlEnabled = process.env.TAPE_JSONL === "1";
  if (jsonlEnabled) {
    console.log("[tape] JSONL sidecar: enabled");
  } else {
    console.log("[tape] JSONL sidecar: disabled");
  }
}

export function isJsonlEnabled(): boolean {
  return jsonlEnabled;
}

function getJsonlPath(): string {
  const now = new Date();
  const utcDate = now.toISOString().split("T")[0];
  if (jsonlDate !== utcDate) {
    jsonlDate = utcDate;
  }
  return path.join("data/tape", `ticks-${jsonlDate}.jsonl`);
}

export function appendTickToJsonl(tickRow: any): void {
  if (!jsonlEnabled) return;

  try {
    const tick = {
      observed_at_ms: tickRow.observed_at_ms,
      source: tickRow.source,
      mint: tickRow.mint,
      pair_address: tickRow.pair_address,
      price_native: tickRow.price_native,
      price_usd: tickRow.price_usd,
      liq_quote: tickRow.liq_quote,
      raw_json: tickRow.raw_json,
      raw_sha256: tickRow.raw_sha256,
    };

    const line = JSON.stringify(tick) + "\n";
    const jsonlPath = getJsonlPath();

    fs.appendFileSync(jsonlPath, line);
  } catch (err: any) {
    recordError("jsonl", "io", `sidecar write failed: ${err.message}`, null);
  }
}

export function flushJsonl(): void {
  // appendFileSync is sync; nothing to flush
}