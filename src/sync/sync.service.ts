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
import {
  BlockExplorerService,
  BlockExplorerNetwork,
  BlockExplorerInternalTx,
  FeeRecord,
  INTERNAL_TRANSFER_NETWORKS,
} from '../block-explorer/block-explorer.service';
import { BinanceService } from '../binance/binance.service';
import { PriceService } from '../price/price.service';
import { TransactionsService } from '../transactions/transactions.service';
import { INTERNAL_WALLETS } from '../transactions/utils/wallets';
import { RawRow } from '../transactions/types';

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
    private readonly blockExplorerService: BlockExplorerService,
    private readonly binanceService: BinanceService,
    private readonly priceService: PriceService,
    private readonly transactionsService: TransactionsService,
  ) {}

  @Cron('0 2 * * *')
  async scheduledSync() {
    if (this.running) {
      this.logger.warn('Sync läuft bereits — geplanter Trigger übersprungen');
      return;
    }
    await this.sync();
  }

  async sync(): Promise<{ synced: number }> {
    if (this.running) throw new Error('Sync läuft bereits');
    this.running = true;
    this.logger.log('Sync gestartet...');

    // Preiscache zurücksetzen: stellt sicher dass jeder Token seine History
    // genau einmal pro Sync lädt (inkl. neuer Tagespreise bis heute)
    this.priceService.resetForSync();

    try {
      const rows: RawRow[] = [];

      for (const [address, info] of INTERNAL_WALLETS) {
        if (info.type === 'EXCHANGE') continue;

        for (const network of Object.keys(ALCHEMY_NETWORKS) as AlchemyNetwork[]) {
          // Standard-Transfers + Fees via Alchemy + BlockExplorer
          rows.push(...(await this.syncWalletAlchemy(address, network)));

          // Interne Transfers (nur BSC/BASE/ARBITRUM — POLYGON läuft über Alchemy)
          if ((INTERNAL_TRANSFER_NETWORKS as string[]).includes(network)) {
            rows.push(
              ...(await this.syncWalletInternalTransfers(
                address,
                network as BlockExplorerNetwork,
              )),
            );
          }
        }
      }

      // Binance
      const binanceState = await this.prisma.syncState.findUnique({
        where: { source: 'BINANCE' },
      });
      rows.push(
        ...(await this.binanceService.syncAll(binanceState?.lastSyncedAt ?? undefined)),
      );
      await this.prisma.syncState.upsert({
        where: { source: 'BINANCE' },
        create: { source: 'BINANCE' },
        update: { lastSyncedAt: new Date() },
      });

      if (rows.length > 0) {
        await this.transactionsService.transformRawData(rows);
      }

      this.logger.log(`Sync abgeschlossen — ${rows.length} Roh-Zeilen verarbeitet`);
      return { synced: rows.length };
    } finally {
      this.running = false;
    }
  }

  // ─── Alchemy: external + erc20 (+ internal für POLYGON) ─────────────────────

  private async syncWalletAlchemy(
    address: string,
    network: AlchemyNetwork,
  ): Promise<RawRow[]> {
    const source = `ALCHEMY:${network}:${address}`;
    const state = await this.prisma.syncState.findUnique({ where: { source } });
    const lastBlock = state?.lastBlock ?? '0x0';
    const startBlockDec = parseInt(lastBlock, 16).toString();

    try {
      // Transfers + aktueller Block + Fees parallel laden
      const [outgoing, incoming, latestBlock, feeMap] = await Promise.all([
        this.alchemyService.getTransfers(network, address, 'from', lastBlock),
        this.alchemyService.getTransfers(network, address, 'to', lastBlock),
        this.alchemyService.getLatestBlock(network),
        this.blockExplorerService.getTransactionFees(
          network as BlockExplorerNetwork,
          address,
          startBlockDec,
        ),
      ]);

      await this.prisma.syncState.upsert({
        where: { source },
        create: { source, lastBlock: latestBlock },
        update: { lastBlock: latestBlock },
      });

      const rows: RawRow[] = [];
      for (const t of outgoing) {
        const r = await this.alchemyTransferToRawRow(t, address, network, 'OUT', feeMap);
        if (r) rows.push(r);
      }
      for (const t of incoming) {
        const r = await this.alchemyTransferToRawRow(t, address, network, 'IN', feeMap);
        if (r) rows.push(r);
      }
      return rows;
    } catch (err) {
      this.logger.error(
        `Alchemy-Sync fehlgeschlagen für ${address} auf ${network}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private async alchemyTransferToRawRow(
    transfer: AlchemyTransfer,
    wallet: string,
    network: AlchemyNetwork,
    direction: 'IN' | 'OUT',
    feeMap: Map<string, FeeRecord>,
  ): Promise<RawRow | null> {
    if (!transfer.asset || transfer.value === null || transfer.value === 0) return null;

    const date = transfer.metadata?.blockTimestamp
      ? new Date(transfer.metadata.blockTimestamp)
      : await this.alchemyService.getBlockTimestamp(network, transfer.blockNum);

    const asset = normalizeAsset(transfer.asset);
    const amount = String(transfer.value);

    // ERC20-Tokens über Netzwerk + Kontraktadresse suchen; native Coins über Symbol
    const alchemyNetwork = ALCHEMY_NETWORKS[network];
    const contractAddress = transfer.rawContract?.address;
    const prices = contractAddress
      ? await this.priceService.getPriceByAddress(alchemyNetwork, contractAddress, asset, date)
      : await this.priceService.getPrice(asset, date);

    // Fee nur wenn wir der Einreicher dieser Tx waren (from = our wallet)
    const isSubmitter = transfer.from.toLowerCase() === wallet.toLowerCase();
    const feeRecord = isSubmitter ? feeMap.get(transfer.hash.toLowerCase()) : undefined;

    // Fee-Preis: immer native Coin (kein Contract) → Symbol-Lookup
    const feeNativeSymbol = NETWORK_NATIVE_TOKEN[network];
    const feePrices =
      feeRecord && feeNativeSymbol !== asset
        ? await this.priceService.getPrice(feeNativeSymbol, date)
        : prices;

    return {
      date: date.toISOString(),
      wallet_address: wallet,
      source_type: `TYPE_${network}`,
      direction,
      asset,
      amount,
      fee: feeRecord?.feeAmount ?? '0',
      fee_asset: feeRecord?.feeAsset ?? feeNativeSymbol,
      price_usd: String(prices.usd),
      value_usd: String(transfer.value * prices.usd),
      price_eur: String(prices.eur),
      value_eur: String(transfer.value * prices.eur),
      // Für Transaction.priceUsd/valueUsd wird der Fee-Asset-Preis benötigt
      // Wir missbrauchen hier temporär price_usd/eur für das Fee-Asset wenn nötig
      // → der TransactionsService nimmt priceUsd vom Row für die Fee-Bewertung
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
      // Preise des Fee-Assets für korrekte Fee-Bewertung in Transaction-Tabelle
      ...(feeRecord && {
        price_usd: String(feePrices.usd),
        value_usd: String(transfer.value * feePrices.usd),
        price_eur: String(feePrices.eur),
        value_eur: String(transfer.value * feePrices.eur),
      }),
    };
  }

  // ─── BlockExplorer: interne Transfers (BSC / Base / Arbitrum) ────────────────

  private async syncWalletInternalTransfers(
    address: string,
    network: BlockExplorerNetwork,
  ): Promise<RawRow[]> {
    const source = `EXPLORER:${network}:${address}`;
    const state = await this.prisma.syncState.findUnique({ where: { source } });
    const startBlock = state?.lastBlock ? parseInt(state.lastBlock, 16).toString() : '0';

    try {
      // Interne Transfers + Fees parallel laden
      const [txs, feeMap] = await Promise.all([
        this.blockExplorerService.getInternalTransfers(network, address, startBlock),
        this.blockExplorerService.getTransactionFees(network, address, startBlock),
      ]);

      if (txs.length === 0) return [];

      const maxBlock = Math.max(...txs.map((t) => Number(t.blockNumber)));
      const maxBlockHex = `0x${maxBlock.toString(16)}`;
      await this.prisma.syncState.upsert({
        where: { source },
        create: { source, lastBlock: maxBlockHex },
        update: { lastBlock: maxBlockHex },
      });

      const rows: RawRow[] = [];
      for (const tx of txs) {
        const r = await this.blockExplorerTxToRawRow(tx, address, network, feeMap);
        if (r) rows.push(r);
      }
      return rows;
    } catch (err) {
      this.logger.error(
        `BlockExplorer-Sync fehlgeschlagen für ${address} auf ${network}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private async blockExplorerTxToRawRow(
    tx: BlockExplorerInternalTx,
    wallet: string,
    network: BlockExplorerNetwork,
    feeMap: Map<string, FeeRecord>,
  ): Promise<RawRow | null> {
    const amountEth = Number(tx.value) / 1e18;
    if (amountEth === 0) return null;

    const direction: 'IN' | 'OUT' =
      tx.from.toLowerCase() === wallet.toLowerCase() ? 'OUT' : 'IN';

    const date = new Date(Number(tx.timeStamp) * 1000);
    const asset = tx.nativeSymbol;
    const amount = String(amountEth);
    const prices = await this.priceService.getPrice(asset, date);

    // Fee nur wenn wir die Transaktion eingereicht haben
    const isSubmitter = tx.from.toLowerCase() === wallet.toLowerCase();
    const feeRecord = isSubmitter ? feeMap.get(tx.hash.toLowerCase()) : undefined;

    return {
      date: date.toISOString(),
      wallet_address: wallet,
      source_type: `TYPE_${network}`,
      direction,
      asset,
      amount,
      fee: feeRecord?.feeAmount ?? '0',
      fee_asset: feeRecord?.feeAsset ?? asset,
      price_usd: String(prices.usd),
      value_usd: String(amountEth * prices.usd),
      price_eur: String(prices.eur),
      value_eur: String(amountEth * prices.eur),
      network,
      from_address: tx.from,
      to_address: tx.to,
      tx_hash: tx.hash,
      operation: 'INTERNAL_TRANSFER',
      note: '',
    };
  }
}
