import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export type MoralisNetwork = 'POLYGON' | 'BSC' | 'BASE' | 'ARBITRUM';

export const MORALIS_CHAIN_IDS: Record<MoralisNetwork, string> = {
  POLYGON: '0x89',
  BSC: '0x38',
  BASE: '0x2105',
  ARBITRUM: '0xa4b1',
};

export const MORALIS_NATIVE_TOKEN: Record<MoralisNetwork, string> = {
  POLYGON: 'MATIC',
  BSC: 'BNB',
  BASE: 'ETH',
  ARBITRUM: 'ETH',
};

/** Alchemy-Netzwerkname für PriceService (bleibt Alchemy Prices API) */
export const MORALIS_TO_ALCHEMY_NETWORK: Record<MoralisNetwork, string> = {
  POLYGON: 'polygon-mainnet',
  BSC: 'bnb-mainnet',
  BASE: 'base-mainnet',
  ARBITRUM: 'arb-mainnet',
};

export interface MoralisNativeTransfer {
  from_address: string;
  to_address: string;
  value: string;
  value_formatted: string;
  token_symbol: string;
  direction: 'send' | 'receive';
  internal_transaction: boolean;
}

export interface MoralisErc20Transfer {
  from_address: string;
  to_address: string;
  value: string;
  value_formatted: string;
  token_symbol: string;
  token_name: string;
  token_address: string;
  token_decimals: string;
  direction: 'send' | 'receive';
  possible_spam: boolean;
}

export interface MoralisTransaction {
  hash: string;
  from_address: string;
  to_address: string | null;
  gas_price: string;
  receipt_gas_used: string;
  receipt_status: string;
  block_timestamp: string;
  block_number: string;
  possible_spam: boolean;
  native_transfers: MoralisNativeTransfer[];
  erc20_transfers: MoralisErc20Transfer[];
}

@Injectable()
export class MoralisService {
  private readonly logger = new Logger(MoralisService.name);
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://deep-index.moralis.io/api/v2.2',
      headers: { 'X-API-Key': process.env.MORALIS_API_KEY ?? '' },
      timeout: 30_000,
    });

    console.log(process.env.MORALIS_API_KEY);
  }

  async getWalletHistory(
    network: MoralisNetwork,
    address: string,
    fromDate?: Date,
    toDate?: Date,
  ): Promise<MoralisTransaction[]> {
    const chain = MORALIS_CHAIN_IDS[network];
    const results: MoralisTransaction[] = [];
    let cursor: string | undefined;

    do {
      const params: Record<string, unknown> = {
        chain,
        order: 'ASC',
        limit: 100,
        include_internal_transactions: true,
        exclude_spam_transactions: false,
      };
      if (fromDate) params.from_date = fromDate.toISOString();
      if (toDate) params.to_date = toDate.toISOString();
      if (cursor) params.cursor = cursor;

      const { data } = await this.client.get(`/wallets/${address}/history`, {
        params,
      });

      const page: MoralisTransaction[] = (data.result ?? []).filter(
        (tx: MoralisTransaction) => tx.receipt_status === '1',
      );
      results.push(...page);
      cursor = (data.cursor as string | undefined) ?? undefined;
    } while (cursor);

    this.logger.log(
      `[${network}] ${address}: ${results.length} Transaktionen (Moralis)`,
    );
    return results;
  }
}
