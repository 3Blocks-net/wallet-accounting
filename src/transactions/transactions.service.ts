// src/transactions/transactions.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SpamTokenService } from '../spam-token/spam-token.service';
import { AggregatedTx, RawRow } from './types';
import { getWalletName, isInternalAddress } from './utils/wallets';
import { Transaction } from '@prisma/client';

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

  async findByTxId(txId: string) {
    const [tx, spamSymbols] = await Promise.all([
      this.prisma.transaction.findUnique({
        where: { txId },
        include: { transfers: true },
      }),
      this.spamTokenService.getSpamSymbols(),
    ]);
    if (!tx) return null;
    return this.enrichWithSpam(tx, spamSymbols);
  }

  async findAll(kind?: string) {
    const [txs, spamSymbols] = await Promise.all([
      this.prisma.transaction.findMany({
        where: kind ? { kind: kind as any } : {},
        include: { transfers: true },
        orderBy: { date: 'desc' },
      }),
      this.spamTokenService.getSpamSymbols(),
    ]);
    return txs.map((tx) => this.enrichWithSpam(tx, spamSymbols));
  }

  private enrichWithSpam(tx: any, spamSymbols: Set<string>) {
    return {
      ...tx,
      transfers: tx.transfers.map((t: any) => ({
        ...t,
        isSpam: spamSymbols.has(t.asset?.toUpperCase() ?? ''),
      })),
    };
  }

  private async saveTransactions(txs: AggregatedTx[]) {
    // for (const tx of txs) {
    //   // Transaction erstellen falls nicht vorhanden
    //   const transaction = await this.prisma.transaction.upsert({
    //     where: { txId: tx.txId },
    //     update: {}, // nichts überschreiben
    //     create: {
    //       txId: tx.txId,
    //       date: new Date(tx.date),
    //       sourceType: tx.sourceType,
    //       kind: tx.kind,
    //     },
    //   });

    //   // Transfers hinzufügen (keine Duplikate)
    //   await this.prisma.transfer.createMany({
    //     data: tx.transfers.map((t) => ({
    //       asset: t.asset,
    //       amount: t.amount,
    //       from: t.from,
    //       to: t.to,
    //       direction: t.direction,
    //       priceUsd: t.priceUsd,
    //       valueUsd: t.valueUsd,
    //       priceEur: t.priceEur,
    //       valueEur: t.valueEur,
    //       transactionId: transaction.txId,
    //     })),
    //     skipDuplicates: true,
    //   });
    // }

    const transactionsData = txs.map((tx) => ({
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
    }));

    // 1️⃣ Alle Transactions auf einmal speichern
    await this.prisma.transaction.createMany({
      data: transactionsData,
      skipDuplicates: true,
    });

    // 2️⃣ Alle Transfers sammeln
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
        priceUsd: t.priceUsd,
        valueUsd: t.valueUsd,
        priceEur: t.priceEur,
        valueEur: t.valueEur,
        transactionId: tx.txId,
      })),
    );

    // 3️⃣ Alle Transfers auf einmal speichern
    await this.prisma.transfer.createMany({
      data: transfersData,
      skipDuplicates: true,
    });
  }
}
