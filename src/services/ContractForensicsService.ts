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
  detectedRisks: string[];
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
      detectedRisks: [],
    };

    try {
      // 1. Direct On-Chain RPC Check (Instant & 100% accurate)
      const onChainData = await this.checkOnChainAuthorities(mintAddress);
      report.isMintDisabled = onChainData.isMintDisabled;
      report.isFreezeDisabled = onChainData.isFreezeDisabled;

      if (!report.isMintDisabled) report.reasons.push("Mint authority is active");
      if (!report.isFreezeDisabled) report.reasons.push("Freeze authority is active");

      // 2. On-Chain Concentration Check
      report.top10ConcentrationPct = await this.fetchTopHolderConcentration(mintAddress, onChainData.totalSupply);
      if (report.top10ConcentrationPct > 25) {
        report.reasons.push(`High top 10 concentration: ${report.top10ConcentrationPct.toFixed(1)}%`);
      }

      // 3. RugCheck & Market Liquidity Audit
      const rugcheckData = await this.fetchRugcheckReport(mintAddress);
      report.rugcheckScore = rugcheckData.score;
      report.detectedRisks = rugcheckData.criticalRisks;
      report.isLiquiditySafe = rugcheckData.liquidityLocked || rugcheckData.liquidityUsd >= 10000;

      if (!report.isLiquiditySafe) {
        report.reasons.push(`Low or unlocked liquidity ($${Math.round(rugcheckData.liquidityUsd)})`);
      }

      if (rugcheckData.criticalRisks.length > 0) {
        report.reasons.push(`RugCheck flags: ${rugcheckData.criticalRisks.join(", ")}`);
      }

      // Final Pass/Fail Status
      if (
        report.isMintDisabled &&
        report.isFreezeDisabled &&
        report.isLiquiditySafe &&
        report.top10ConcentrationPct <= 25 &&
        report.detectedRisks.length === 0
      ) {
        report.status = "PASS";
      }
    } catch (e: any) {
      logger.error("FORENSICS", "ContractForensics", "Error analyzing token", { mintAddress, error: e.message });
      report.reasons.push(`Forensics error: ${e.message}`);
    }

    return report;
  }

  private async checkOnChainAuthorities(mintAddress: string) {
    const mintPubKey = new PublicKey(mintAddress);
    const info = await this.connection.getParsedAccountInfo(mintPubKey);

    if (!info.value || !("parsed" in info.value.data)) {
      throw new Error("Invalid mint account or parsing failed");
    }

    const data = info.value.data.parsed.info;
    return {
      isMintDisabled: data.mintAuthority === null,
      isFreezeDisabled: data.freezeAuthority === null,
      totalSupply: BigInt(data.supply || 0),
    };
  }

  private async fetchTopHolderConcentration(mintAddress: string, totalSupply: bigint): Promise<number> {
    if (totalSupply === 0n) return 0;
    try {
      const largest = await this.connection.getTokenLargestAccounts(new PublicKey(mintAddress));
      if (!largest.value || largest.value.length === 0) return 0;

      const top10 = largest.value.slice(0, 10);
      const top10Sum = top10.reduce((acc, accInfo) => acc + BigInt(accInfo.amount || 0), 0n);

      return Number((top10Sum * 10000n) / totalSupply) / 100;
    } catch {
      return 0; // Fallback to 0 if RPC call fails
    }
  }

  private async fetchRugcheckReport(mintAddress: string) {
    const url = `${this.rugcheckUrl}/${mintAddress}/report`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`RugCheck HTTP ${response.status}`);
      const data = await response.json();

      // Extract LP Liquidity from nested markets
      let totalLiquidityUsd = 0;
      let isLpLocked = false;

      if (Array.isArray(data.markets)) {
        for (const market of data.markets) {
          totalLiquidityUsd += market.lp?.lpLockedUSD || market.liquidity || 0;
          if (market.lp?.lpLockedPct > 50 || market.lp?.lpLocked) isLpLocked = true;
        }
      }

      // Extract critical risks
      const criticalRisks: string[] = [];
      if (Array.isArray(data.risks)) {
        for (const risk of data.risks) {
          if (risk.level === "danger") {
            criticalRisks.push(risk.name || risk.description);
          }
        }
      }

      return {
        score: data.score || 0,
        liquidityUsd: totalLiquidityUsd,
        liquidityLocked: isLpLocked,
        criticalRisks,
      };
    } catch {
      clearTimeout(timeoutId);
      return { score: 0, liquidityUsd: 0, liquidityLocked: false, criticalRisks: [] };
    }
  }
}

export const contractForensicsService = new ContractForensicsService();
export default contractForensicsService;
