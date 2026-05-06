import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface AlchemyErc20Transfer {
  blockNum: string;
  hash: string;
  from: string;
  to: string;
  asset: string | null;
  value: number | null;
  rawContract: {
    value: string | null;
    address: string | null;
    decimal: string | null;
  };
  metadata: {
    blockTimestamp: string;
  };
}

// Ungefähre Blocknummern bei 2025-05-01 — werden nur beim initialen Sync genutzt
const GENESIS_BLOCKS: Record<string, string> = {
  'polygon-mainnet': '0x43A0000',  // ~71.3M
  'bnb-mainnet':     '0x2F00000',  // ~49.8M
  'base-mainnet':    '0x1AE0000',  // ~28.3M
  'arb-mainnet':     '0x14000000', // ~335.5M
};

@Injectable()
export class AlchemyTransfersService {
  private readonly logger = new Logger(AlchemyTransfersService.name);

  private baseUrl(network: string): string {
    return `https://${network}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY ?? ''}`;
  }

  genesisBlock(alchemyNetwork: string): string {
    return GENESIS_BLOCKS[alchemyNetwork] ?? '0x0';
  }

  async getCurrentBlock(alchemyNetwork: string): Promise<string> {
    const { data } = await axios.post(
      this.baseUrl(alchemyNetwork),
      { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
      { timeout: 10_000 },
    );
    return (data?.result as string | undefined) ?? '0x0';
  }

  async getErc20Transfers(
    alchemyNetwork: string,
    address: string,
    fromBlock: string,
  ): Promise<AlchemyErc20Transfer[]> {
    const [outgoing, incoming] = await Promise.all([
      this.fetchPages(alchemyNetwork, { fromAddress: address, fromBlock }),
      this.fetchPages(alchemyNetwork, { toAddress: address, fromBlock }),
    ]);

    // Gleiche Transaktion kann in beiden Listen auftauchen (fromUs && toUs)
    const seen = new Set<string>();
    const all: AlchemyErc20Transfer[] = [];
    for (const t of [...outgoing, ...incoming]) {
      const key = `${t.hash}:${t.from}:${t.to}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(t);
      }
    }
    return all;
  }

  private async fetchPages(
    alchemyNetwork: string,
    filter: { fromAddress?: string; toAddress?: string; fromBlock: string },
  ): Promise<AlchemyErc20Transfer[]> {
    const results: AlchemyErc20Transfer[] = [];
    let pageKey: string | undefined;

    do {
      const params: Record<string, unknown> = {
        category: ['erc20'],
        fromBlock: filter.fromBlock,
        toBlock: 'latest',
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: '0x3e8', // 1000
      };
      if (filter.fromAddress) params.fromAddress = filter.fromAddress;
      if (filter.toAddress) params.toAddress = filter.toAddress;
      if (pageKey) params.pageKey = pageKey;

      const { data } = await axios.post(
        this.baseUrl(alchemyNetwork),
        { jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] },
        { timeout: 30_000 },
      );

      const result = data?.result;
      results.push(...(result?.transfers ?? []));
      pageKey = result?.pageKey as string | undefined;
    } while (pageKey);

    return results;
  }

  // Präzise Betragsberechnung aus rohem Hex-Wert + Dezimalstellen
  formatAmount(transfer: AlchemyErc20Transfer): string {
    const { rawContract, value } = transfer;
    if (rawContract.value && rawContract.decimal) {
      try {
        const raw = BigInt(rawContract.value);
        const dec = parseInt(rawContract.decimal, 16);
        if (dec === 0) return raw.toString();
        const divisor = 10n ** BigInt(dec);
        const whole = raw / divisor;
        const frac = (raw % divisor)
          .toString()
          .padStart(dec, '0')
          .replace(/0+$/, '');
        return frac ? `${whole}.${frac}` : String(whole);
      } catch {
        // Fallback auf Float-Wert
      }
    }
    return String(value ?? 0);
  }
}
