import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export const ALCHEMY_NETWORKS = {
  POLYGON: 'polygon-mainnet',
  BSC: 'bnb-mainnet',
  BASE: 'base-mainnet',
  ARBITRUM: 'arb-mainnet',
} as const;

export type AlchemyNetwork = keyof typeof ALCHEMY_NETWORKS;

export const NETWORK_NATIVE_TOKEN: Record<AlchemyNetwork, string> = {
  POLYGON: 'MATIC',
  BSC: 'BNB',
  BASE: 'ETH',
  ARBITRUM: 'ETH',
};

export interface AlchemyTransfer {
  blockNum: string;
  uniqueId: string;
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  asset: string | null;
  category: string;
  rawContract: { value: string; address: string | null; decimal: string };
  // metadata ist auf manchen Chains (z.B. BSC internal) nicht immer befüllt
  metadata?: { blockTimestamp: string };
}

@Injectable()
export class AlchemyService {
  private readonly logger = new Logger(AlchemyService.name);
  private readonly clients = new Map<AlchemyNetwork, AxiosInstance>();

  // Block-Timestamps cachen um redundante RPC-Calls zu vermeiden
  private readonly blockTimestampCache = new Map<string, Date>();

  constructor() {
    const apiKey = process.env.ALCHEMY_API_KEY ?? '';
    for (const [key, network] of Object.entries(ALCHEMY_NETWORKS)) {
      this.clients.set(
        key as AlchemyNetwork,
        axios.create({
          baseURL: `https://${network}.g.alchemy.com/v2/${apiKey}`,
          timeout: 30_000,
        }),
      );
    }
  }

  async getTransfers(
    network: AlchemyNetwork,
    address: string,
    direction: 'from' | 'to',
    fromBlock = '0x0',
  ): Promise<AlchemyTransfer[]> {
    const client = this.clients.get(network)!;
    const transfers: AlchemyTransfer[] = [];
    let pageKey: string | undefined;

    do {
      const params: Record<string, unknown> = {
        [direction === 'from' ? 'fromAddress' : 'toAddress']: address,
        fromBlock,
        toBlock: 'latest',
        // 'internal' erfasst native Coin-Transfers über Smart Contracts (z.B. BNB via DeFi)
        category: ['external', 'internal', 'erc20'],
        withMetadata: true,
        maxCount: '0x3e8', // 1000 pro Seite
      };
      if (pageKey) params.pageKey = pageKey;

      const { data } = await client.post('', {
        jsonrpc: '2.0',
        method: 'alchemy_getAssetTransfers',
        params: [params],
        id: 1,
      });

      if (data.error) {
        this.logger.error(
          `Alchemy-Fehler auf ${network} für ${address}: ${JSON.stringify(data.error)}`,
        );
        break;
      }

      transfers.push(...(data.result.transfers as AlchemyTransfer[]));
      pageKey = data.result.pageKey as string | undefined;
    } while (pageKey);

    this.logger.log(
      `[${network}] ${direction}=${address}: ${transfers.length} Transfers gefunden`,
    );
    return transfers;
  }

  async getLatestBlock(network: AlchemyNetwork): Promise<string> {
    const { data } = await this.clients.get(network)!.post('', {
      jsonrpc: '2.0',
      method: 'eth_blockNumber',
      params: [],
      id: 1,
    });
    return data.result as string;
  }

  /**
   * Block-Timestamp via RPC abrufen.
   * Fallback wenn metadata.blockTimestamp in alchemy_getAssetTransfers fehlt
   * (passiert auf BSC bei internal transfers).
   */
  async getBlockTimestamp(network: AlchemyNetwork, blockHex: string): Promise<Date> {
    const cacheKey = `${network}:${blockHex}`;
    if (this.blockTimestampCache.has(cacheKey)) {
      return this.blockTimestampCache.get(cacheKey)!;
    }

    const { data } = await this.clients.get(network)!.post('', {
      jsonrpc: '2.0',
      method: 'eth_getBlockByNumber',
      params: [blockHex, false],
      id: 1,
    });

    const ts = parseInt(data.result?.timestamp ?? '0x0', 16);
    const date = new Date(ts * 1000);
    this.blockTimestampCache.set(cacheKey, date);
    return date;
  }
}
