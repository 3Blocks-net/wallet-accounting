// src/transactions/utils/parse-safe.ts
import { Prisma } from '@prisma/client';
import { buildMatchKey } from './match-key';

export type RawSafeRow = {
  Nonce: string;
  'Safe Address': string;
  'From Address': string;
  'To Address': string;
  'Transaction Hash': string;
  'Contract Address': string;
  Amount: string;
  'Asset Type': string;
  'Asset Symbol': string;
  'Created at': string;
  'Executed at': string;
  'Proposer Address': string;
  'Executor Address': string;
  Note: string;
};

export function parseSafeCsvRow(row: RawSafeRow) {
  const amount = new Prisma.Decimal(row['Amount'] || '0');
  const assetSymbol = row['Asset Symbol'] || 'UNKNOWN';
  const txHash = row['Transaction Hash'] || null;

  return {
    source: 'SAFE',
    safeAddress: row['Safe Address'] || null,
    binanceType: null,
    txHash,
    fromAddress: row['From Address'] || null,
    toAddress: row['To Address'] || null,
    assetSymbol,
    assetType: row['Asset Type'] || 'unknown',
    amount,
    fee: null,
    createdAt: row['Created at'] ? new Date(row['Created at']) : new Date(),
    executedAt: row['Executed at'] ? new Date(row['Executed at']) : null,
    note: row['Note'] || null,
    matchKey: buildMatchKey(txHash, assetSymbol, amount),
  };
}
