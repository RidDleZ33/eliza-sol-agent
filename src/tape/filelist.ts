// Shared tape file discovery for read-only tools
// Discovers day files in the retention window and optionally legacy file.

import { existsSync, readdirSync, unlinkSync } from "fs";
import { getTapeRetainDays } from "../utils/env";

const TAPE_DIR = "data/tape";
const LEGACY_DB = "data/tape/tape.sqlite";

export function dateFilename(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dayFilePath(dateStr: string): string {
  return `${TAPE_DIR}/tape-${dateStr}.sqlite`;
}

export interface TapeFile {
  path: string;
  kind: "day" | "legacy";
}

export function discoverTapeFiles(includeLegacy?: boolean): TapeFile[] {
  const retainDays = getTapeRetainDays();
  const cutoff = new Date(Date.now() - retainDays * 86400000);
  const cutoffStr = dateFilename(cutoff);
  const files: TapeFile[] = [];

  if (!existsSync(TAPE_DIR)) return files;

  try {
    const allFiles = readdirSync(TAPE_DIR).filter(
      (f: string) => f.endsWith(".sqlite")
    );

    for (const f of allFiles) {
      const path = `${TAPE_DIR}/${f}`;

      // Day file: tape-YYYY-MM-DD.sqlite
      if (f.startsWith("tape-") && f.length === 27) {
        const datePart = f.slice(5, 15);
        if (datePart >= cutoffStr) {
          files.push({ path, kind: "day" });
        }
      }

      // Legacy file
      if (f === "tape.sqlite" && includeLegacy) {
        files.push({ path, kind: "legacy" });
      }
    }
  } catch (e: any) {
    console.log(`[tape] discover failed: ${e.message}`);
  }

  return files;
}