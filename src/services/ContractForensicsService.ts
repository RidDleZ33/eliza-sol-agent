import { Connection, PublicKey } from "@solana/web3.js";
import { getSolanaRpcUrl, getRugcheckApiUrl } from "../utils/env.ts";
import { logger } from "./LoggerService.ts";

export interface ContractSecurityReport {
  mintAddress: string;
  isMintDisabled: boolean;
  isFreezeDisabled: boolean;
  isLiquiditySafe: boolean;
  top10ConcentrationPct: number;
  rugcheckScore: number;
  status: "PASS" | "HIGH_RISK";
  reasons: string[];
}

export class ContractForensicsService {
  private connection: Connection;
  private rugcheckUrl: string;

  constructor() {
    this.connection = new Connection(getSolanaRpcUrl(), "confirmed");
    this.rugcheckUrl = getRugcheckApiUrl();
  }

  async analyzeToken(mintAddress: string): Promise<ContractSecurityReport> {
    const report: ContractSecurityReport = {
      mintAddress,
      isMintDisabled: false,
      isFreezeDisabled: false,
      isLiquiditySafe: false,
      top10ConcentrationPct: 0,
      rugcheckScore: 0,
      status: "HIGH_RISK",
      reasons: [],
    };

    try {
      // Fetch RugCheck report
      const rugcheckData = await this.fetchRugcheckReport(mintAddress);
      report.rugcheckScore = rugcheckData.riskScore;

      // Check mint authority
      report.isMintDisabled = rugcheckData.mintAuthority === null;
      if (!report.isMintDisabled) {
        report.reasons.push(`Mint authority active: ${rugcheckData.mintAuthority}`);
      }

      // Check freeze authority
      report.isFreezeDisabled = rugcheckData.freezeAuthority === null;
      if (!report.isFreezeDisabled) {
        report.reasons.push(`Freeze authority active: ${rugcheckData.freezeAuthority}`);
      }

      // Check liquidity
      report.isLiquiditySafe = rugcheckData.liquidityLocked && rugcheckData.liquidityUsd >= 10000;
      if (!report.isLiquiditySafe) {
        if (rugcheckData.liquidityUsd < 10000) {
          report.reasons.push(`Low liquidity: $${rugcheckData.liquidityUsd}`);
        }
        if (!rugcheckData.liquidityLocked) {
          report.reasons.push("Liquidity not locked");
        }
      }

      // Check holder concentration
      report.top10ConcentrationPct = rugcheckData.top10ConcentrationPct;
      if (rugcheckData.top10ConcentrationPct >= 25) {
        report.reasons.push(`High top 10 concentration: ${rugcheckData.top10ConcentrationPct}%`);
      }

      // Determine overall status
      if (
        report.isMintDisabled &&
        report.isFreezeDisabled &&
        report.isLiquiditySafe &&
        report.top10ConcentrationPct < 25
      ) {
        report.status = "PASS";
      }
    } catch (e) {
      logger.error("FORENSICS", "ContractForensics", "Error analyzing token", { mintAddress, error: e.message });
      report.reasons.push(`Analysis failed: ${e.message}`);
    }

    return report;
  }

  private async fetchRugcheckReport(mintAddress: string) {
    const url = `${this.rugcheckUrl}/${mintAddress}/report/summary`;
    const timeoutMs = 30000; // 30 second timeout for API call

    logger.info("FORENSICS", "ContractForensics", "Fetching RugCheck report", { mintAddress, url });
    const startTime = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      const elapsed = Date.now() - startTime;
      logger.info("FORENSICS", "ContractForensics", "RugCheck API response", { mintAddress, status: response.status, elapsedMs: elapsed });

      if (!response.ok) {
        throw new Error(`RugCheck API returned ${response.status}`);
      }

      const data = await response.json();

      // Parse RugCheck response
      return {
        riskScore: data.riskScore || 0,
        mintAuthority: data.mintAuthority || null,
        freezeAuthority: data.freezeAuthority || null,
        liquidityLocked: data.liquidityLocked || false,
        liquidityUsd: data.liquidityUsd || 0,
        top10ConcentrationPct: data.top10ConcentrationPct || 0,
      };
    } catch (e) {
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      if (e.name === 'AbortError') {
        logger.error("FORENSICS", "ContractForensics", "RugCheck API timeout", { mintAddress, timeoutMs, elapsedMs: elapsed });
        throw new Error(`RugCheck API timeout after ${timeoutMs}ms`);
      }
      logger.error("FORENSICS", "ContractForensics", "RugCheck API error", { mintAddress, elapsedMs: elapsed, error: e.message });
      throw e;
    }
  }
}

export const contractForensicsService = new ContractForensicsService();
export default contractForensicsService;