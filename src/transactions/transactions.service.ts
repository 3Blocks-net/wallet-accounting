// src/transactions/transactions.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, TransactionClassification } from '@prisma/client';
import { parseSafeCsvRow, RawSafeRow } from './utils/parse-safe';
import {
  parseBinanceDepositRow,
  parseBinanceWithdrawRow,
  RawBinanceDepositRow,
  RawBinanceWithdrawRow,
} from './utils/parse-binance';
import { classify, TransactionInput } from './utils/classify';
import { isInternalAddress } from './utils/wallets';

@Injectable()
export class TransactionsService {
  constructor(private prisma: PrismaService) {}

  async importAll(params: {
    safeRows: RawSafeRow[];
    binanceDepositRows: RawBinanceDepositRow[];
    binanceWithdrawRows: RawBinanceWithdrawRow[];
  }) {
    const safeTxs = params.safeRows.map(parseSafeCsvRow);

    const binanceDepositTxs = params.binanceDepositRows.map(
      parseBinanceDepositRow,
    );
    const binanceWithdrawTxs = params.binanceWithdrawRows.map(
      parseBinanceWithdrawRow,
    );

    const safeMatchKeys = new Set(
      safeTxs.map((tx) => tx.matchKey).filter((k): k is string => !!k),
    );

    const finalTxs: TransactionInput[] = [...safeTxs];

    const allBinance = [...binanceDepositTxs, ...binanceWithdrawTxs];

    for (const btx of allBinance) {
      const refersToMyWallet = isInternalAddress(btx.toAddress);
      const hasOnchainMatch = !!btx.matchKey && safeMatchKeys.has(btx.matchKey);

      // nur speichern, wenn kein Bezug zu deinen Wallets
      // UND kein onchain Match
      if (!refersToMyWallet && !hasOnchainMatch) {
        finalTxs.push(btx);
      }
    }

    const txsWithClass = finalTxs.map((tx) => ({
      ...tx,
      classification: classify(tx),
    }));

    await this.prisma.$transaction(
      txsWithClass.map((tx) =>
        this.prisma.transaction.create({
          data: {
            source: tx.source,
            safeAddress: tx.safeAddress,
            binanceType: tx.binanceType,
            txHash: tx.txHash,
            fromAddress: tx.fromAddress,
            toAddress: tx.toAddress,
            assetSymbol: tx.assetSymbol,
            assetType: tx.assetType,
            amount: tx.amount as Prisma.Decimal,
            fee: tx.fee as Prisma.Decimal | null,
            createdAt: tx.createdAt,
            executedAt: tx.executedAt,
            note: tx.note,
            matchKey: tx.matchKey,
            classification: tx.classification as TransactionClassification,
          },
        }),
      ),
    );

    await this.recalculateBalances();
  }

  private async recalculateBalances() {
    const txs = await this.prisma.transaction.findMany({
      where: { source: 'SAFE' },
      orderBy: { createdAt: 'asc' },
    });

    const balances = new Map<string, Map<string, Prisma.Decimal>>();

    for (const tx of txs) {
      const asset = tx.assetSymbol;
      const amount = tx.amount as Prisma.Decimal;

      if (tx.fromAddress) {
        const w = tx.fromAddress.toLowerCase();
        if (!balances.has(w)) balances.set(w, new Map());
        const m = balances.get(w)!;
        m.set(asset, (m.get(asset) || new Prisma.Decimal(0)).minus(amount));
      }

      if (tx.toAddress) {
        const w = tx.toAddress.toLowerCase();
        if (!balances.has(w)) balances.set(w, new Map());
        const m = balances.get(w)!;
        m.set(asset, (m.get(asset) || new Prisma.Decimal(0)).plus(amount));
      }
    }

    const asOf = txs.length ? txs[txs.length - 1].createdAt : new Date();

    const balanceRows: Prisma.WalletBalanceCreateManyInput[] = [];
    for (const [wallet, assetMap] of balances.entries()) {
      for (const [assetSymbol, balance] of assetMap.entries()) {
        balanceRows.push({
          wallet,
          assetSymbol,
          balance,
          asOf,
        });
      }
    }

    await this.prisma.walletBalance.deleteMany({});
    await this.prisma.walletBalance.createMany({ data: balanceRows });
  }
}
