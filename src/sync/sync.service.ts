import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import {
  MoralisService,
  MoralisNetwork,
  MoralisTransaction,
  MORALIS_CHAIN_IDS,
  MORALIS_NATIVE_TOKEN,
  MORALIS_TO_ALCHEMY_NETWORK,
} from '../moralis/moralis.service';
import { BinanceService } from '../binance/binance.service';
import { TransactionsService } from '../transactions/transactions.service';
import { AlchemyTransfersService } from '../alchemy/alchemy-transfers.service';
import { INTERNAL_WALLETS } from '../transactions/utils/wallets';
import { RawRow } from '../transactions/types';

const COMPANY_GENESIS = new Date('2025-05-01T00:00:00Z');

const CHUNK_DAYS = 90;

const WRAPPED_TO_NATIVE: Record<string, string> = {
  WBNB: 'BNB',
  WETH: 'ETH',
  WMATIC: 'MATIC',
  WPOL: 'POL',
};

function normalizeAsset(symbol: string): string {
  return WRAPPED_TO_NATIVE[symbol.toUpperCase()] ?? symbol;
}

function weiToNative(wei: bigint): string {
  if (wei === 0n) return '0';
  const divisor = 10n ** 18n;
  const whole = wei / divisor;
  const frac = (wei % divisor).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moralisService: MoralisService,
    private readonly binanceService: BinanceService,
    private readonly transactionsService: TransactionsService,
    private readonly alchemyTransfersService: AlchemyTransfersService,
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

    try {
      const rows: RawRow[] = [];

      for (const [address, info] of INTERNAL_WALLETS) {
        if (info.type === 'EXCHANGE') continue;

        for (const network of Object.keys(
          MORALIS_CHAIN_IDS,
        ) as MoralisNetwork[]) {
          const [moralisRows, alchemyRows] = await Promise.all([
            this.syncWalletMoralis(address, network),
            this.syncWalletAlchemy(address, network),
          ]);
          rows.push(...moralisRows, ...alchemyRows);
        }
      }

      const binanceState = await this.prisma.syncState.findUnique({
        where: { source: 'BINANCE' },
      });
      rows.push(
        ...(await this.binanceService.syncAll(
          binanceState?.lastSyncedAt ?? undefined,
        )),
      );
      await this.prisma.syncState.upsert({
        where: { source: 'BINANCE' },
        create: { source: 'BINANCE' },
        update: { lastSyncedAt: new Date() },
      });

      if (rows.length > 0) {
        await this.transactionsService.transformRawData(rows);
      }

      this.logger.log(
        `Sync abgeschlossen — ${rows.length} Roh-Zeilen verarbeitet`,
      );
      return { synced: rows.length };
    } finally {
      this.running = false;
    }
  }

  private async syncWalletMoralis(
    address: string,
    network: MoralisNetwork,
  ): Promise<RawRow[]> {
    const source = `MORALIS:${network}:${address}`;
    const state = await this.prisma.syncState.findUnique({ where: { source } });

    const syncedThrough: Date = state?.lastBlock
      ? new Date(state.lastBlock)
      : COMPANY_GENESIS;

    const now = new Date();
    const fromDate = new Date(syncedThrough.getTime() - 24 * 60 * 60 * 1000);

    const chunkEnd = new Date(
      Math.min(
        syncedThrough.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000,
        now.getTime(),
      ),
    );
    const isUpToDate =
      chunkEnd.getTime() >= now.getTime() - 24 * 60 * 60 * 1000;
    const toDate = isUpToDate ? undefined : chunkEnd;

    try {
      const txs = await this.moralisService.getWalletHistory(
        network,
        address,
        fromDate,
        toDate,
      );

      const newSyncedThrough = toDate ?? now;
      await this.prisma.syncState.upsert({
        where: { source },
        create: { source, lastBlock: newSyncedThrough.toISOString() },
        update: { lastBlock: newSyncedThrough.toISOString() },
      });

      if (toDate) {
        this.logger.log(
          `[${network}] ${address}: Chunk ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)} verarbeitet — weiterer Sync nötig`,
        );
      }

      const rows: RawRow[] = [];
      for (const tx of txs) {
        rows.push(...this.moralisTxToRawRows(tx, address, network));
      }
      return rows;
    } catch (err) {
      this.logger.error(
        `Moralis-Sync fehlgeschlagen für ${address} auf ${network}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private async syncWalletAlchemy(
    address: string,
    network: MoralisNetwork,
  ): Promise<RawRow[]> {
    const alchemyNetwork = MORALIS_TO_ALCHEMY_NETWORK[network];
    const source = `ALCHEMY_BACKUP:${network}:${address}`;
    const state = await this.prisma.syncState.findUnique({ where: { source } });
    const fromBlock =
      state?.lastBlock ??
      this.alchemyTransfersService.genesisBlock(alchemyNetwork);

    try {
      const [transfers, currentBlock] = await Promise.all([
        this.alchemyTransfersService.getErc20Transfers(
          alchemyNetwork,
          address,
          fromBlock,
        ),
        this.alchemyTransfersService.getCurrentBlock(alchemyNetwork),
      ]);

      await this.prisma.syncState.upsert({
        where: { source },
        create: { source, lastBlock: currentBlock },
        update: { lastBlock: currentBlock },
      });

      const walletLower = address.toLowerCase();
      const nativeSymbol = MORALIS_NATIVE_TOKEN[network];
      const rows: RawRow[] = [];

      for (const t of transfers) {
        const fromUs = t.from?.toLowerCase() === walletLower;
        const toUs = t.to?.toLowerCase() === walletLower;
        if (!fromUs && !toUs) continue;

        const asset = normalizeAsset(t.asset ?? '');
        if (!asset || !t.rawContract.address) continue;

        const amount = this.alchemyTransfersService.formatAmount(t);
        if (!amount || Number(amount) === 0) continue;

        const direction: 'IN' | 'OUT' = fromUs ? 'OUT' : 'IN';

        rows.push({
          date: new Date(t.metadata.blockTimestamp).toISOString(),
          wallet_address: address,
          source_type: `TYPE_${network}`,
          direction,
          asset,
          amount,
          fee: '0',
          fee_asset: nativeSymbol,
          price_usd: '0',
          value_usd: '0',
          price_eur: '0',
          value_eur: '0',
          network,
          from_address: t.from ?? '',
          to_address: t.to ?? '',
          tx_hash: t.hash,
          token_address: t.rawContract.address,
          operation: 'ERC20_TRANSFER',
          note: '',
        });
      }

      if (rows.length > 0) {
        this.logger.log(
          `[Alchemy Backup] ${network} ${address}: ${rows.length} ERC20-Transfers`,
        );
      }
      return rows;
    } catch (err) {
      this.logger.error(
        `Alchemy-Backup-Sync fehlgeschlagen für ${address} auf ${network}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private moralisTxToRawRows(
    tx: MoralisTransaction,
    wallet: string,
    network: MoralisNetwork,
  ): RawRow[] {
    const date = new Date(tx.block_timestamp).toISOString();
    const walletLower = wallet.toLowerCase();
    const nativeSymbol = MORALIS_NATIVE_TOKEN[network];

    let feeAmount = '0';
    if (
      tx.receipt_gas_used &&
      tx.gas_price &&
      tx.receipt_gas_used !== '0' &&
      tx.gas_price !== '0' &&
      tx.from_address?.toLowerCase() === walletLower
    ) {
      const feeWei = BigInt(tx.receipt_gas_used) * BigInt(tx.gas_price);
      feeAmount = weiToNative(feeWei);
    }

    const rows: RawRow[] = [];
    let feeAttached = false;

    const takeFee = (): string => {
      if (feeAttached || feeAmount === '0') return '0';
      feeAttached = true;
      return feeAmount;
    };

    for (const nt of tx.native_transfers) {
      const fromUs = nt.from_address?.toLowerCase() === walletLower;
      const toUs = nt.to_address?.toLowerCase() === walletLower;
      if (!fromUs && !toUs) continue;

      const asset = normalizeAsset(nt.token_symbol ?? nativeSymbol);
      const amount = nt.value_formatted;
      if (!amount || Number(amount) === 0) continue;

      rows.push({
        date,
        wallet_address: wallet,
        source_type: `TYPE_${network}`,
        direction: fromUs ? 'OUT' : 'IN',
        asset,
        amount,
        fee: takeFee(),
        fee_asset: nativeSymbol,
        price_usd: '0',
        value_usd: '0',
        price_eur: '0',
        value_eur: '0',
        network,
        from_address: nt.from_address ?? '',
        to_address: nt.to_address ?? '',
        tx_hash: tx.hash,
        token_address: '',
        operation: nt.internal_transaction
          ? 'INTERNAL_TRANSFER'
          : 'NATIVE_TRANSFER',
        note: '',
      });
    }

    for (const et of tx.erc20_transfers) {
      const fromUs = et.from_address?.toLowerCase() === walletLower;
      const toUs = et.to_address?.toLowerCase() === walletLower;
      if (!fromUs && !toUs) continue;

      const asset = normalizeAsset(et.token_symbol ?? '');
      const amount = et.value_formatted;
      if (!asset || !amount || Number(amount) === 0) continue;
      if (!et.token_address) continue;

      rows.push({
        date,
        wallet_address: wallet,
        source_type: `TYPE_${network}`,
        direction: fromUs ? 'OUT' : 'IN',
        asset,
        amount,
        fee: takeFee(),
        fee_asset: nativeSymbol,
        price_usd: '0',
        value_usd: '0',
        price_eur: '0',
        value_eur: '0',
        network,
        from_address: et.from_address ?? '',
        to_address: et.to_address ?? '',
        tx_hash: tx.hash,
        token_address: et.token_address ?? '',
        operation: 'ERC20_TRANSFER',
        note: '',
      });
    }

    return rows;
  }
}
