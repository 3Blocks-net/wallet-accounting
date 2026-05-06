import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PriceService } from './price.service';

const NETWORK_TO_ALCHEMY: Record<string, string> = {
  POLYGON: 'polygon-mainnet',
  BSC: 'bnb-mainnet',
  BASE: 'base-mainnet',
  ARBITRUM: 'arb-mainnet',
};

const EUR_ASSETS = new Set(['EUR', 'CHF', 'GBP']);

@Injectable()
export class PriceEnrichmentService {
  private readonly logger = new Logger(PriceEnrichmentService.name);
  private running = false;

  private get eurUsdRate(): number {
    return parseFloat(process.env.EUR_USD_RATE ?? '0.92');
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceService: PriceService,
  ) {}

  async enrichAll(): Promise<{ enrichedTransfers: number; enrichedFees: number }> {
    if (this.running) throw new Error('Preis-Enrichment läuft bereits');
    this.running = true;
    this.logger.log('Preis-Enrichment gestartet...');

    try {
      const [transferCount, feeCount] = await Promise.all([
        this.enrichTransfers(),
        this.enrichFees(),
      ]);

      this.logger.log(
        `Preis-Enrichment abgeschlossen — ${transferCount} Transfers, ${feeCount} Fees aktualisiert`,
      );
      return { enrichedTransfers: transferCount, enrichedFees: feeCount };
    } finally {
      this.running = false;
    }
  }

  private async enrichTransfers(): Promise<number> {
    const transfers = await this.prisma.transfer.findMany({
      select: {
        id: true,
        asset: true,
        amount: true,
        tokenAddress: true,
        transaction: {
          select: { date: true, network: true },
        },
      },
    });

    let count = 0;
    for (const t of transfers) {
      const prices = await this.lookupPrice(
        t.asset,
        t.tokenAddress ?? null,
        t.transaction.network,
        t.transaction.date,
      );

      const amount = Number(t.amount);
      await this.prisma.transfer.update({
        where: { id: t.id },
        data: {
          priceUsd: String(prices.usd),
          valueUsd: String(amount * prices.usd),
          priceEur: String(prices.eur),
          valueEur: String(amount * prices.eur),
        },
      });
      count++;
    }

    return count;
  }

  private async enrichFees(): Promise<number> {
    const txs = await this.prisma.transaction.findMany({
      where: {
        feeAmount: { not: null },
        feeAsset: { not: null },
      },
      select: {
        txId: true,
        date: true,
        network: true,
        feeAsset: true,
        feeAmount: true,
      },
    });

    let count = 0;
    for (const tx of txs) {
      const prices = await this.lookupPrice(
        tx.feeAsset!,
        null,
        tx.network,
        tx.date,
      );

      const feeAmount = Number(tx.feeAmount);
      await this.prisma.transaction.update({
        where: { txId: tx.txId },
        data: {
          priceUsd: String(prices.usd),
          valueUsd: String(feeAmount * prices.usd),
          priceEur: String(prices.eur),
          valueEur: String(feeAmount * prices.eur),
        },
      });
      count++;
    }

    return count;
  }

  private async lookupPrice(
    asset: string,
    tokenAddress: string | null,
    network: string,
    date: Date,
  ): Promise<{ usd: number; eur: number }> {
    const sym = asset.toUpperCase();

    // Fiat-Währungen: statischer Kurs
    if (sym === 'USD' || sym === 'USDT' || sym === 'USDC') {
      return { usd: 1.0, eur: this.eurUsdRate };
    }
    if (EUR_ASSETS.has(sym)) {
      return { usd: 1 / this.eurUsdRate, eur: 1.0 };
    }

    const alchemyNetwork = NETWORK_TO_ALCHEMY[network.toUpperCase()];

    if (tokenAddress && alchemyNetwork) {
      return this.priceService.getPriceByAddress(
        alchemyNetwork,
        tokenAddress,
        asset,
        date,
      );
    }

    return this.priceService.getPrice(asset, date);
  }
}
