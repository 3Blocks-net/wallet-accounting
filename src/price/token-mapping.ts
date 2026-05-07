export const FIAT_CURRENCIES = new Set(['EUR', 'USD', 'CHF', 'GBP']);

export const STABLECOINS = new Set([
  'USDT',
  'USDC',
  'BUSD',
  'DAI',
  'FDUSD',
  'TUSD',
  'USDP',
  'FRAX',
  'PYUSD',
]);

export const NETWORK_TO_ALCHEMY: Record<string, string> = {
  POLYGON: 'polygon-mainnet',
  BSC: 'bnb-mainnet',
  BASE: 'base-mainnet',
  ARBITRUM: 'arb-mainnet',
};

export const HISTORY_START_DATE = '2025-04-01';
export const ADDRESS_BATCH_SIZE = 25;
export const HISTORY_CHUNK_DAYS = 90;

export type FetchMode = 'symbol' | 'address';

export interface MissingToken {
  tokenKey: string;
  symbol: string;
  tokenAddress?: string;
  network?: string;
  alchemyNetwork?: string;
  fetchMode: FetchMode;
  affectedTransfers: number;
  isSpam: boolean;
}

export interface FetchResult {
  fetched: number;
  spam: number;
}

export interface ApplyResult {
  transfers: number;
  fees: number;
}
