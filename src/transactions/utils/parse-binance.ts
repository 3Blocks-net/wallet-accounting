// src/transactions/utils/parse-binance.ts
import { Prisma } from '@prisma/client';
import { buildMatchKey } from './match-key';

export type RawBinanceDepositRow = {
  'Date(UTC+0)': string;
  Coin: string;
  Network: string;
  Amount: string;
  Address: string;
  TXID: string;
  Status: string;
};

export type RawBinanceWithdrawRow = {
  'Date(UTC+0)': string;
  Coin: string;
  Network: string;
  Amount: string;
  Fee: string;
  Address: string;
  TXID: string;
  Status: string;
};

function parseBinanceDate(s: string): Date {
  const [datePart, timePart] = s.split(' ');
  const [yy, mm, dd] = datePart.split('-').map(Number);
  const [hh, mi, ss] = timePart.split(':').map(Number);
  const year = 2000 + yy;
  return new Date(Date.UTC(year, mm - 1, dd, hh, mi, ss));
}

export function parseBinanceDepositRow(row: RawBinanceDepositRow) {
  const amount = new Prisma.Decimal(row['Amount'] || '0');
  const assetSymbol = row['Coin'];
  const txHash = row['TXID'] || null;

  return {
    source: 'BINANCE_DEPOSIT',
    safeAddress: null,
    binanceType: 'DEPOSIT',
    txHash,
    fromAddress: null,
    toAddress: row['Address'] || null,
    assetSymbol,
    assetType: 'spot',
    amount,
    fee: null,
    createdAt: parseBinanceDate(row['Date(UTC+0)']),
    executedAt: null,
    note: row['Status'] || null,
    matchKey: buildMatchKey(txHash, assetSymbol, amount),
  };
}

export function parseBinanceWithdrawRow(row: RawBinanceWithdrawRow) {
  const amount = new Prisma.Decimal(row['Amount'] || '0');
  const assetSymbol = row['Coin'];
  const txHash = row['TXID'] || null;

  return {
    source: 'BINANCE_WITHDRAW',
    safeAddress: null,
    binanceType: 'WITHDRAW',
    txHash,
    fromAddress: null,
    toAddress: row['Address'] || null,
    assetSymbol,
    assetType: 'spot',
    amount,
    fee: new Prisma.Decimal(row['Fee'] || '0'),
    createdAt: parseBinanceDate(row['Date(UTC+0)']),
    executedAt: null,
    note: row['Status'] || null,
    matchKey: buildMatchKey(txHash, assetSymbol, amount),
  };
}
