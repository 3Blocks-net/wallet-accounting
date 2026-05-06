import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SpamTokenService } from '../spam-token/spam-token.service';
import { AggregatedTx, RawRow } from './types';
import { getWalletName, isInternalAddress } from './utils/wallets';
import { Transaction } from '@prisma/client';

const NETWORK_TO_ALCHEMY: Record<string, string> = {
  POLYGON: 'polygon-mainnet',
  BSC: 'bnb-mainnet',
  BASE: 'base-mainnet',
  ARBITRUM: 'arb-mainnet',
};

function buildBinanceId(row: RawRow) {
  // Kannst du nach Bedarf anpassen (z.B. note kürzen / hash aus note bilden)
  return row.tx_hash === ''
    ? `BINANCE:${row.date}:${row.source_type}:${row.note || row.asset}`
    : row.tx_hash;
}

@Injectable()
export class TransactionsService {
  constructor(
    private prisma: PrismaService,
    private spamTokenService: SpamTokenService,
  ) {}

  async transformRawData(rawRows: RawRow[]): Promise<Transaction[]> {
    const map = new Map<string, AggregatedTx>();
    for (const row of rawRows) {
      const isBinance = row.source_type.startsWith('TYPE_BINANCE');

      const key = isBinance
        ? buildBinanceId(row)
        : row.tx_hash || `${row.date}:${row.source_type}:${row.asset}`;

      let agg = map.get(key);
      if (!agg) {
        agg = {
          date: row.date,
          txId: key,
          sourceType: row.source_type,
          kind: 'PAYMENT', // wird gleich überschrieben
          network: row.network === '' ? 'BINANCE' : row.network,
          note: row.note || '',
          transfers: [],
          feeAsset: row.fee_asset || null,
          feeAmount: row.fee || null,
          priceUsd: Number(row.fee) === 0 ? null : row.price_usd,
          valueUsd:
            (Number(row.fee) * Number(row.price_usd)).toString() || null,
          priceEur: Number(row.fee) === 0 ? null : row.price_eur,
          valueEur: (Number(row.fee) * Number(row.price_eur)).toString() || '',
          feePayerAddress:
            Number(row.fee) === 0
              ? null
              : isBinance
                ? 'BINANCE_WALLET'
                : row.from_address,
          feePayer:
            Number(row.fee) === 0
              ? null
              : isBinance
                ? 'BINANCE_WALLET'
                : getWalletName(row.from_address) || null,
        };
        map.set(key, agg);
      } else if (!agg.feeAmount && Number(row.fee) > 0) {
        // Fee aus späterer Row übernehmen — passiert wenn die fee-tragende Row
        // nicht als erste für diesen Tx-Hash verarbeitet wurde
        agg.feeAsset = row.fee_asset || null;
        agg.feeAmount = row.fee;
        agg.priceUsd = row.price_usd;
        agg.valueUsd = String(Number(row.fee) * Number(row.price_usd));
        agg.priceEur = row.price_eur;
        agg.valueEur = String(Number(row.fee) * Number(row.price_eur));
        agg.feePayerAddress = isBinance ? 'BINANCE_WALLET' : row.from_address;
        agg.feePayer = isBinance
          ? 'BINANCE_WALLET'
          : getWalletName(row.from_address) || null;
      }

      if (Number(row.amount) === 0) continue;
      agg.transfers.push({
        asset: row.asset,
        amount: row.amount,
        priceUsd: row.price_usd,
        valueUsd: row.value_usd,
        priceEur: row.price_eur,
        valueEur: row.value_eur,
        direction: row.direction,
        tokenAddress: row.token_address || null,
        operation: row.operation || '',
        note: row.note || '',
        from:
          isBinance && row.direction === 'OUT'
            ? 'BINANCE_WALLET'
            : row.from_address,
        to:
          isBinance && row.direction === 'IN'
            ? 'BINANCE_WALLET'
            : row.to_address,
        sender: getWalletName(row.from_address),
        receiver: getWalletName(row.to_address),
      });
    }

    // Klassifizierung (IN / OUT / INTERNAL)
    for (const agg of map.values()) {
      // const anyFromMine = agg.transfers.some((t) => isInternalAddress(t.from));
      // const anyToMine = agg.transfers.some((t) => isInternalAddress(t.to));

      // // 1️⃣ INTERNAL hat immer Priorität
      // if (anyFromMine && anyToMine) {
      //   agg.kind = 'INTERNAL';
      //   continue;
      // }

      const outgoing = agg.transfers.filter((t) => isInternalAddress(t.from));
      const incoming = agg.transfers.filter((t) => isInternalAddress(t.to));

      const tokenOut = outgoing.length > 0;
      const tokenIn = incoming.length > 0;

      const differentAssets = outgoing.some((o) =>
        incoming.some((i) => i.asset !== o.asset),
      );

      // 1️⃣ SWAP
      if (tokenOut && tokenIn && differentAssets) {
        agg.kind = 'SWAP';
        continue;
      }

      // 2️⃣ INTERNAL
      if (tokenOut && tokenIn) {
        agg.kind = 'INTERNAL';
        continue;
      }

      // 3️⃣ PAYMENT_OUT — von uns nach extern
      if (tokenOut && !tokenIn) {
        agg.kind = 'PAYMENT_OUT';
        continue;
      }

      // 4️⃣ PAYMENT_IN — von extern zu uns
      if (!tokenOut && tokenIn) {
        agg.kind = 'PAYMENT_IN';
        continue;
      }
    }

    //swap transaction 0x92ffdc7fa33202d8ad28a2367886bf5336af7d567b81d7ac46e40aa9584d6953

    // In ein Array umwandeln
    const aggregatedTxs = Array.from(map.values());

    // Aufsteigend nach Datum sortieren
    aggregatedTxs.sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      return dateA - dateB; // aufsteigend
    });

    await this.saveTransactions(aggregatedTxs);

    return await this.prisma.transaction.findMany({
      where: {
        txId: {
          in: aggregatedTxs.map((t) => t.txId),
        },
      },
      include: {
        transfers: true,
      },
    });
  }

  async updateTransaction(
    txId: string,
    data: {
      kind?: string;
      note?: string;
      isSpam?: boolean;
      feeAsset?: string;
      feeAmount?: string;
      feePayerAddress?: string;
      feePayer?: string;
      priceUsd?: string;
      valueUsd?: string;
      priceEur?: string;
      valueEur?: string;
    },
  ) {
    const tx = await this.prisma.transaction.update({
      where: { txId },
      data,
      include: { transfers: true },
    });
    const spamKeys = await this.spamTokenService.getSpamKeys();
    return this.enrichWithSpam(tx, spamKeys);
  }

  async findByTxId(txId: string) {
    const [tx, spamKeys] = await Promise.all([
      this.prisma.transaction.findUnique({
        where: { txId },
        include: { transfers: true },
      }),
      this.spamTokenService.getSpamKeys(),
    ]);
    if (!tx) return null;
    return this.enrichWithSpam(tx, spamKeys);
  }

  async findAll(filters: {
    kind?: string;
    network?: string;
    sourceType?: string;
    asset?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const where: any = {};

    if (filters.kind) where.kind = filters.kind;
    if (filters.network) where.network = filters.network;
    if (filters.sourceType) where.sourceType = filters.sourceType;

    if (filters.dateFrom || filters.dateTo) {
      where.date = {};
      if (filters.dateFrom) where.date.gte = new Date(filters.dateFrom);
      if (filters.dateTo) {
        const to = new Date(filters.dateTo);
        to.setUTCHours(23, 59, 59, 999);
        where.date.lte = to;
      }
    }

    if (filters.asset) {
      where.transfers = {
        some: { asset: { equals: filters.asset, mode: 'insensitive' } },
      };
    }

    const [txs, spamKeys] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: { transfers: true },
        orderBy: { date: 'desc' },
      }),
      this.spamTokenService.getSpamKeys(),
    ]);
    return txs.map((tx) => this.enrichWithSpam(tx, spamKeys));
  }

  private enrichWithSpam(tx: any, spamKeys: Set<string>) {
    return {
      ...tx,
      isSpam: tx.isSpam ?? false,
      transfers: tx.transfers.map((t: any) => ({
        ...t,
        isSpam: this.isTransferSpam(t, tx.network, spamKeys),
      })),
    };
  }

  private isTransferSpam(
    transfer: any,
    txNetwork: string,
    spamKeys: Set<string>,
  ): boolean {
    if (transfer.tokenAddress) {
      const alchemyNet =
        NETWORK_TO_ALCHEMY[txNetwork?.toUpperCase()] ?? txNetwork;
      return spamKeys.has(
        `${alchemyNet}:${transfer.tokenAddress.toLowerCase()}`,
      );
    }
    return spamKeys.has(`SYMBOL:${transfer.asset?.toUpperCase() ?? ''}`);
  }

  private async saveTransactions(txs: AggregatedTx[]) {
    const txIds = txs.map((tx) => tx.txId);

    // 1️⃣ Herausfinden welche txIds bereits existieren
    const existing = await this.prisma.transaction.findMany({
      where: { txId: { in: txIds } },
      select: { txId: true },
    });
    const existingIds = new Set(existing.map((t) => t.txId));

    const newTxs = txs.filter((tx) => !existingIds.has(tx.txId));
    const existingTxs = txs.filter((tx) => existingIds.has(tx.txId));

    // 2️⃣ Neue Transactions anlegen
    if (newTxs.length > 0) {
      await this.prisma.transaction.createMany({
        data: newTxs.map((tx) => ({
          txId: tx.txId,
          date: new Date(tx.date),
          sourceType: tx.sourceType,
          kind: tx.kind,
          network: tx.network,
          note: tx.note,
          feeAsset: tx.feeAsset,
          feeAmount: tx.feeAmount,
          priceUsd: tx.priceUsd,
          valueUsd: tx.valueUsd,
          priceEur: tx.priceEur,
          valueEur: tx.valueEur,
          feePayerAddress: tx.feePayerAddress,
          feePayer: tx.feePayer,
        })),
      });
    }

    // 3️⃣ Bestehende Transactions aktualisieren
    //    - kind, note: nicht überschreiben (manuell per PATCH gesetzt)
    //    - priceUsd/valueUsd/priceEur/valueEur: nicht überschreiben (werden durch
    //      den Preis-Enrichment-Endpoint befüllt, nicht durch den Sync)
    if (existingTxs.length > 0) {
      await Promise.all(
        existingTxs.map((tx) =>
          this.prisma.transaction.update({
            where: { txId: tx.txId },
            data: {
              date: new Date(tx.date),
              sourceType: tx.sourceType,
              network: tx.network,
              feeAsset: tx.feeAsset,
              feeAmount: tx.feeAmount,
              feePayerAddress: tx.feePayerAddress,
              feePayer: tx.feePayer,
            },
          }),
        ),
      );
    }

    // 4️⃣ Transfers hinzufügen — neue werden ergänzt, bestehende (unique constraint)
    //    bleiben unverändert
    const transfersData = txs.flatMap((tx) =>
      tx.transfers.map((t) => ({
        asset: t.asset,
        amount: t.amount,
        from: t.from,
        to: t.to,
        sender: t.sender,
        note: t.note,
        operation: t.operation,
        receiver: t.receiver,
        direction: t.direction,
        tokenAddress: t.tokenAddress,
        priceUsd: t.priceUsd,
        valueUsd: t.valueUsd,
        priceEur: t.priceEur,
        valueEur: t.valueEur,
        transactionId: tx.txId,
      })),
    );

    await this.prisma.transfer.createMany({
      data: transfersData,
      skipDuplicates: true,
    });
  }
}
