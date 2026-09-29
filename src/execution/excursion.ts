// Phase 11A: MFE (max favorable excursion) and MAE (max adverse excursion)
// Pure helpers; called by PositionManagerService on position close.
// Entry, peak, and trough are all in the same units (SOL per token).

export function mfePct(entry: number, peak: number): number {
  if (peak <= 0 || entry <= 0) return 0;
  return ((peak - entry) / entry) * 100;
}

export function maePct(entry: number, trough: number): number {
  if (trough <= 0 || entry <= 0) return 0;
  return ((trough - entry) / entry) * 100;
}

export function excursionSnippet(
  entry: number,
  peak: number,
  trough: number,
  hv: number | null,
  regime: string | null
): string {
  const mfe = mfePct(entry, peak);
  const mae = maePct(entry, trough);
  const mfeStr = mfe >= 0 ? `+${mfe.toFixed(1)}%` : `${mfe.toFixed(1)}%`;
  const maeStr = mae >= 0 ? `+${mae.toFixed(1)}%` : `${mae.toFixed(1)}%`;
  return `MFE ${mfeStr} MAE ${maeStr} hv=${hv ?? "na"} regime=${regime ?? "na"}`;
}
