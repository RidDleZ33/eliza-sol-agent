// Phase 4A: Extract volatility stop computation as a pure function for testing.
// stop_pct = clamp(k * hv, 0.08, 0.25)

export function volStopPct(hv: number, k: number = 1.5): number {
  const raw = k * hv;
  const clamped = Math.min(0.25, Math.max(0.08, raw));
  return clamped * 100; // return as percentage (e.g., 12.5)
}
