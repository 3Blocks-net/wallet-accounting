// src/transactions/utils/match-key.ts
import { Prisma } from '@prisma/client';

export function buildMatchKey(
  hash: string | null | undefined,
  symbol: string,
  amount: string | Prisma.Decimal,
) {
  if (!hash) return null;
  const dec =
    amount instanceof Prisma.Decimal ? amount : new Prisma.Decimal(amount);
  return [hash.toLowerCase(), symbol.toUpperCase(), dec.toFixed(6)].join('|');
}
