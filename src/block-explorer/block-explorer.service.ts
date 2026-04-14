import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Etherscan API V2 — einzige Base-URL für alle EVM-Netzwerke.
 * Migration: https://docs.etherscan.io/v2-migration
 * API-Key registrieren: https://etherscan.io/myapikey (ein Key für alle Chains)
 */
const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api';

export type BlockExplorerNetwork = 'POLYGON' | 'BSC' | 'BASE' | 'ARBITRUM';

/** Netzwerke ohne Alchemy-internal-Support → brauchen BlockExplorer für interne Transfers */
export const INTERNAL_TRANSFER_NETWORKS: BlockExplorerNetwork[] = ['BSC', 'BASE', 'ARBITRUM'];

interface ExplorerConfig {
  chainId: string;
  nativeSymbol: string;
}

const EXPLORER_CONFIG: Record<BlockExplorerNetwork, ExplorerConfig> = {
  POLYGON:  { chainId: '137',   nativeSymbol: 'MATIC' },
  BSC:      { chainId: '56',    nativeSymbol: 'BNB'   },
  BASE:     { chainId: '8453',  nativeSymbol: 'ETH'   },
  ARBITRUM: { chainId: '42161', nativeSymbol: 'ETH'   },
};

export interface BlockExplorerInternalTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;          // in Wei
  isError: string;
  type: string;
  network: BlockExplorerNetwork;
  nativeSymbol: string;
}

/** Vorberechnete Fee-Daten pro Tx-Hash */
export interface FeeRecord {
  feeAmount: string;        // in nativer Einheit (z.B. "0.000421" BNB)
  feeAsset: string;
  feePayerAddress: string;
}

@Injectable()
export class BlockExplorerService {
  private readonly logger = new Logger(BlockExplorerService.name);

  // ─── Interne Transfers (native Coin via Smart Contract) ──────────────────────

  async getInternalTransfers(
    network: BlockExplorerNetwork,
    address: string,
    startBlock = '0',
  ): Promise<BlockExplorerInternalTx[]> {
    const config = EXPLORER_CONFIG[network];
    if (!this.apiKey()) return this.warnNoKey([]);

    return this.paginate<BlockExplorerInternalTx>(
      config,
      { action: 'txlistinternal', address, startblock: startBlock },
      (tx) =>
        tx.isError === '0' && BigInt(tx.value) > 0n
          ? { ...tx, network, nativeSymbol: config.nativeSymbol }
          : null,
      `interne Transfers [${network}] ${address}`,
    );
  }

  // ─── Fee-Lookup via txlist ────────────────────────────────────────────────────

  /**
   * Baut eine Fee-Map auf: Map<txHash (lowercase), FeeRecord>
   * Fee = gasUsed × gasPrice / 1e18 (in nativer Einheit).
   */
  async getTransactionFees(
    network: BlockExplorerNetwork,
    address: string,
    startBlock = '0',
  ): Promise<Map<string, FeeRecord>> {
    const config = EXPLORER_CONFIG[network];
    if (!this.apiKey()) return this.warnNoKey(new Map());

    const records = await this.paginate<{
      hash: string;
      gasUsed: string;
      gasPrice: string;
      from: string;
    }>(
      config,
      { action: 'txlist', address, startblock: startBlock },
      (tx) => {
        if (tx.from.toLowerCase() !== address.toLowerCase()) return null;
        return { hash: tx.hash, gasUsed: tx.gasUsed, gasPrice: tx.gasPrice, from: tx.from };
      },
      `Fees [${network}] ${address}`,
    );

    const feeMap = new Map<string, FeeRecord>();
    for (const r of records) {
      const feeWei = BigInt(r.gasUsed) * BigInt(r.gasPrice);
      feeMap.set(r.hash.toLowerCase(), {
        feeAmount: this.weiToNative(feeWei),
        feeAsset: config.nativeSymbol,
        feePayerAddress: r.from,
      });
    }

    this.logger.log(`[${network}] ${address}: ${feeMap.size} Fee-Einträge geladen`);
    return feeMap;
  }

  // ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

  private apiKey(): string {
    return process.env.ETHERSCAN_API_KEY ?? '';
  }

  private warnNoKey<T>(fallback: T): T {
    this.logger.warn(
      'ETHERSCAN_API_KEY nicht gesetzt — BlockExplorer-Abfragen werden übersprungen. ' +
        'Registrieren: https://etherscan.io/myapikey (ein Key für alle Chains)',
    );
    return fallback;
  }

  /**
   * Generische Pagination für Etherscan V2.
   * Ruft page=1,2,… ab bis weniger als `offset` Einträge zurückkommen.
   */
  private async paginate<T>(
    config: ExplorerConfig,
    extraParams: Record<string, string>,
    transform: (raw: any) => T | null,
    logLabel: string,
  ): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    const offset = 10_000;

    while (true) {
      try {
        const { data } = await axios.get(ETHERSCAN_V2_URL, {
          params: {
            chainid: config.chainId,
            module: 'account',
            ...extraParams,
            endblock: '99999999',
            page,
            offset,
            sort: 'asc',
            apikey: this.apiKey(),
          },
          timeout: 15_000,
        });

        if (data.status === '0') {
          if (data.message !== 'No transactions found') {
            this.logger.error(
              `BlockExplorer-Fehler [${logLabel}]: ${data.message} — ${data.result ?? '(kein Detail)'}`,
            );
          }
          break;
        }

        for (const raw of data.result as any[]) {
          const mapped = transform(raw);
          if (mapped !== null) results.push(mapped);
        }

        if ((data.result as any[]).length < offset) break;
        page++;
      } catch (err) {
        this.logger.error(
          `BlockExplorer-Request fehlgeschlagen [${logLabel}]: ${(err as Error).message}`,
        );
        break;
      }
    }

    return results;
  }

  /** Wei (BigInt) präzise in native Einheit umwandeln (kein Floating-Point). */
  private weiToNative(wei: bigint): string {
    if (wei === 0n) return '0';
    const divisor = 10n ** 18n;
    const whole = wei / divisor;
    const frac = (wei % divisor).toString().padStart(18, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : String(whole);
  }
}
