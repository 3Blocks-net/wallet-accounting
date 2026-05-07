import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ApplyResult, NETWORK_TO_ALCHEMY, STABLECOINS } from './token-mapping';

const APPLY_BATCH_SIZE = 100;

@Injectable()
export class PriceApplyService {
  private readonly logger = new Logger(PriceApplyService.name);

  private get eurUsdRate(): number {
    return parseFloat(process.env.EUR_USD_RATE ?? '0.92');
  }

  constructor(private readonly prisma: PrismaService) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  async applyAll(): Promise<ApplyResult> {
    // Load the full TokenPrice table once — shared between both apply passes
    const priceMap = await this.loadPriceMap();

    const [transfers, fees] = await Promise.all([
      this.applyToTransfers(priceMap),
      this.applyToFees(priceMap),
    ]);

    this.logger.log(
      `Apply complete — ${transfers} transfers, ${fees} fees updated`,
    );
    return { transfers, fees };
  }

  // ─── Transfers ─────────────────────────────────────────────────────────────

  private async applyToTransfers(
    priceMap: Map<string, Array<{ date: string; usd: number }>>,
  ): Promise<number> {
    const transfers = await this.prisma.transfer.findMany({
      where: { priceUsd: '0' },
      select: {
        id: true,
        asset: true,
        amount: true,
        tokenAddress: true,
        transaction: { select: { date: true, network: true } },
      },
    });

    const updates: Array<{
      id: string;
      priceUsd: string;
      valueUsd: string;
      priceEur: string;
      valueEur: string;
    }> = [];

    const eur = this.eurUsdRate;

    for (const t of transfers) {
      const symbol = t.asset.toUpperCase();
      let usd: number;

      if (STABLECOINS.has(symbol)) {
        usd = 1.0;
      } else {
        const tokenKey = this.resolveTokenKey(
          symbol,
          t.tokenAddress ?? null,
          t.transaction.network,
        );
        const found = this.findPrice(priceMap, tokenKey, t.transaction.date);
        if (found === null) continue;
        usd = found;
      }

      const amount = Number(t.amount);
      updates.push({
        id: t.id,
        priceUsd: String(usd),
        valueUsd: String(amount * usd),
        priceEur: String(usd * eur),
        valueEur: String(amount * usd * eur),
      });
    }

    await this.runBatchUpdates(updates);
    return updates.length;
  }

  // ─── Fees ──────────────────────────────────────────────────────────────────

  private async applyToFees(
    priceMap: Map<string, Array<{ date: string; usd: number }>>,
  ): Promise<number> {
    const txs = await this.prisma.transaction.findMany({
      where: {
        feeAsset: { not: null },
        feeAmount: { not: null },
        OR: [{ priceUsd: null }, { priceUsd: '0' }],
      },
      select: {
        txId: true,
        date: true,
        feeAsset: true,
        feeAmount: true,
      },
    });

    const updates: Array<{
      txId: string;
      priceUsd: string;
      valueUsd: string;
      priceEur: string;
      valueEur: string;
    }> = [];

    const eur = this.eurUsdRate;

    for (const tx of txs) {
      const symbol = tx.feeAsset!.toUpperCase();
      let usd: number;

      if (STABLECOINS.has(symbol)) {
        usd = 1.0;
      } else {
        const tokenKey = `SYMBOL:${symbol}`;
        const found = this.findPrice(priceMap, tokenKey, tx.date);
        if (found === null) continue;
        usd = found;
      }

      const feeAmount = Number(tx.feeAmount);
      updates.push({
        txId: tx.txId,
        priceUsd: String(usd),
        valueUsd: String(feeAmount * usd),
        priceEur: String(usd * eur),
        valueEur: String(feeAmount * usd * eur),
      });
    }

    for (let i = 0; i < updates.length; i += APPLY_BATCH_SIZE) {
      const batch = updates.slice(i, i + APPLY_BATCH_SIZE);
      await Promise.all(
        batch.map((u) =>
          this.prisma.transaction.update({
            where: { txId: u.txId },
            data: {
              priceUsd: u.priceUsd,
              valueUsd: u.valueUsd,
              priceEur: u.priceEur,
              valueEur: u.valueEur,
            },
          }),
        ),
      );
    }

    return updates.length;
  }

  // ─── Price lookup helpers ──────────────────────────────────────────────────

  private async loadPriceMap(): Promise<
    Map<string, Array<{ date: string; usd: number }>>
  > {
    const rows = await this.prisma.tokenPrice.findMany({
      select: { tokenKey: true, date: true, priceUsd: true },
    });

    const map = new Map<string, Array<{ date: string; usd: number }>>();
    for (const row of rows) {
      if (!map.has(row.tokenKey)) map.set(row.tokenKey, []);
      map.get(row.tokenKey)!.push({ date: row.date, usd: row.priceUsd });
    }

    // Sort each token's price list ascending by date for binary search
    for (const arr of map.values()) {
      arr.sort((a, b) => a.date.localeCompare(b.date));
    }

    return map;
  }

  private resolveTokenKey(
    symbol: string,
    tokenAddress: string | null,
    network: string,
  ): string {
    const alchemyNetwork = NETWORK_TO_ALCHEMY[network.toUpperCase()];
    if (tokenAddress && tokenAddress !== '' && alchemyNetwork) {
      return `${alchemyNetwork}:${tokenAddress.toLowerCase()}`;
    }
    return `SYMBOL:${symbol}`;
  }

  // Binary search for exact date or closest earlier date
  private findPrice(
    map: Map<string, Array<{ date: string; usd: number }>>,
    tokenKey: string,
    date: Date,
  ): number | null {
    const prices = map.get(tokenKey);
    if (!prices || prices.length === 0) return null;

    const targetDate = date.toISOString().slice(0, 10);
    let lo = 0;
    let hi = prices.length - 1;
    let best: number | null = null;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (prices[mid].date <= targetDate) {
        best = prices[mid].usd;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return best;
  }

  private async runBatchUpdates(
    updates: Array<{
      id: string;
      priceUsd: string;
      valueUsd: string;
      priceEur: string;
      valueEur: string;
    }>,
  ): Promise<void> {
    for (let i = 0; i < updates.length; i += APPLY_BATCH_SIZE) {
      const batch = updates.slice(i, i + APPLY_BATCH_SIZE);
      await Promise.all(
        batch.map((u) =>
          this.prisma.transfer.update({
            where: { id: u.id },
            data: {
              priceUsd: u.priceUsd,
              valueUsd: u.valueUsd,
              priceEur: u.priceEur,
              valueEur: u.valueEur,
            },
          }),
        ),
      );
    }
  }
}
