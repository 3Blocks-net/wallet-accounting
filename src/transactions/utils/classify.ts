// src/transactions/utils/classify.ts
import { TransactionClassification } from '@prisma/client';
import { isInternalAddress } from './wallets';

export type TransactionInput = {
  source: string;
  safeAddress?: string | null;
  binanceType?: string | null;
  txHash?: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
  assetSymbol: string;
  assetType: string;
  amount: any;
  fee?: any;
  createdAt: Date;
  executedAt?: Date | null;
  note?: string | null;
  matchKey?: string | null;
};

export function classify(tx: TransactionInput): TransactionClassification {
  const fromInternal = isInternalAddress(tx.fromAddress);
  const toInternal = isInternalAddress(tx.toAddress);

  if (fromInternal && toInternal) return 'UMBUCHUNG';
  if (!fromInternal && toInternal) return 'EINZAHLUNG';
  if (fromInternal && !toInternal) return 'AUSZAHLUNG';
  return 'UNBEKANNT';
}
