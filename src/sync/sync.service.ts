import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import {
  AlchemyService,
  AlchemyNetwork,
  AlchemyTransfer,
  ALCHEMY_NETWORKS,
  NETWORK_NATIVE_TOKEN,
} from '../alchemy/alchemy.service';
import { BinanceService } from '../binance/binance.service';
import { PriceService } from '../price/price.service';
import { TransactionsService } from '../transactions/transactions.service';
import { INTERNAL_WALLETS } from '../transactions/utils/wallets';
import { RawRow } from '../transactions/types';

/**
 * Wrapped Native Tokens auf ihren nativen Coin normalisieren.
 *
 * Hintergrund: DEX-Swaps wrappen/unwrappen den nativen Coin intern.
 * Dadurch entstehen z.B. WBNB-Transfers neben BNB-Transfers in derselben Tx.
 * Normalisierung verhindert doppelte Assets im Portfolio und stellt
 * konsistentes Preis-Lookup sicher.
 */
const WRAPPED_TO_NATIVE: Record<string, string> = {
  WBNB: 'BNB',
  WETH: 'ETH',
  WMATIC: 'MATIC',
  WPOL: 'POL',
};

function normalizeAsset(symbol: string): string {
  return WRAPPED_TO_NATIVE[symbol.toUpperCase()] ?? symbol;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alchemyService: AlchemyService,
    private readonly binanceService: BinanceService,
    private readonly priceService: PriceService,
    private readonly transactionsService: TransactionsService,
  ) {}

  @Cron('0 2 * * *') // täglich um 02:00 Uhr
  async scheduledSync() {
    if (this.running) {
      this.logger.warn('Sync läuft bereits — geplanter Trigger übersprungen');
      return;
    }
    await this.sync();
  }

  async sync(): Promise<{ synced: number }> {
    if (this.running) {
      throw new Error('Sync läuft bereits');
    }
    this.running = true;
    this.logger.log('Sync gestartet...');

    try {
      const rows: RawRow[] = [];

      // 1. On-Chain-Wallets via Alchemy (alle Netzwerke)
      for (const [address, info] of INTERNAL_WALLETS) {
        if (info.type === 'EXCHANGE') continue;

        for (const network of Object.keys(ALCHEMY_NETWORKS) as AlchemyNetwork[]) {
          const walletRows = await this.syncWallet(address, network);
          rows.push(...walletRows);
        }
      }

      // 2. Binance
      const binanceState = await this.prisma.syncState.findUnique({
        where: { source: 'BINANCE' },
      });
      const binanceRows = await this.binanceService.syncAll(
        binanceState?.lastSyncedAt ?? undefined,
      );
      rows.push(...binanceRows);

      await this.prisma.syncState.upsert({
        where: { source: 'BINANCE' },
        create: { source: 'BINANCE' },
        update: { lastSyncedAt: new Date() },
      });

      // 3. Transformieren und persistieren
      if (rows.length > 0) {
        await this.transactionsService.transformRawData(rows);
      }

      this.logger.log(`Sync abgeschlossen — ${rows.length} Roh-Zeilen verarbeitet`);
      return { synced: rows.length };
    } finally {
      this.running = false;
    }
  }

  // ─── On-Chain-Wallet Sync ─────────────────────────────────────────────────────

  private async syncWallet(address: string, network: AlchemyNetwork): Promise<RawRow[]> {
    const source = `${network}:${address}`;
    const state = await this.prisma.syncState.findUnique({ where: { source } });
    const lastBlock = state?.lastBlock ?? '0x0';

    try {
      const [outgoing, incoming, latestBlock] = await Promise.all([
        this.alchemyService.getTransfers(network, address, 'from', lastBlock),
        this.alchemyService.getTransfers(network, address, 'to', lastBlock),
        this.alchemyService.getLatestBlock(network),
      ]);

      await this.prisma.syncState.upsert({
        where: { source },
        create: { source, lastBlock: latestBlock },
        update: { lastBlock: latestBlock },
      });

      const rows: RawRow[] = [];

      for (const transfer of outgoing) {
        const r = await this.toRawRow(transfer, address, network, 'OUT');
        if (r) rows.push(r);
      }
      for (const transfer of incoming) {
        const r = await this.toRawRow(transfer, address, network, 'IN');
        if (r) rows.push(r);
      }

      return rows;
    } catch (err) {
      this.logger.error(
        `Sync fehlgeschlagen für ${address} auf ${network}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private async toRawRow(
    transfer: AlchemyTransfer,
    wallet: string,
    network: AlchemyNetwork,
    direction: 'IN' | 'OUT',
  ): Promise<RawRow | null> {
    if (!transfer.asset || transfer.value === null || transfer.value === 0) {
      return null;
    }

    // Fallback: metadata.blockTimestamp fehlt auf manchen Chains (z.B. BSC internal)
    // → Block via RPC abrufen (gecacht pro Block)
    const date = transfer.metadata?.blockTimestamp
      ? new Date(transfer.metadata.blockTimestamp)
      : await this.alchemyService.getBlockTimestamp(network, transfer.blockNum);

    // WBNB → BNB, WETH → ETH, etc. normalisieren
    const asset = normalizeAsset(transfer.asset);
    const amount = String(transfer.value);
    const prices = await this.priceService.getPrice(asset, date);

    return {
      date: date.toISOString(),
      wallet_address: wallet,
      source_type: `TYPE_${network}`,
      direction,
      asset,
      amount,
      fee: '0', // TODO: eth_getTransactionReceipt für genaue Gas-Kosten
      fee_asset: NETWORK_NATIVE_TOKEN[network],
      price_usd: String(prices.usd),
      value_usd: String(transfer.value * prices.usd),
      price_eur: String(prices.eur),
      value_eur: String(transfer.value * prices.eur),
      network,
      from_address: transfer.from,
      to_address: transfer.to ?? '',
      tx_hash: transfer.hash,
      operation:
        transfer.category === 'erc20'
          ? 'ERC20_TRANSFER'
          : transfer.category === 'internal'
            ? 'INTERNAL_TRANSFER'
            : 'NATIVE_TRANSFER',
      note: '',
    };
  }
}
