import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const STABLECOINS = new Set([
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

/**
 * Alchemy Token Prices API v1
 * Docs: https://docs.alchemy.com/reference/token-prices-by-address
 *
 * Zwei Lookup-Modi:
 *   1. ERC20  → POST /tokens/by-address   (network + contractAddress)
 *   2. Native/Binance → GET /tokens/historical (symbol)
 *
 * Reuse ALCHEMY_API_KEY. Erfordert Growth Plan+ für Prices API.
 */
const PRICES_BASE = 'https://api.g.alchemy.com/prices/v1';

/** Startdatum für Preishistorie — Firmengründung 3blocks */
const HISTORY_START_UNIX = Math.floor(new Date('2025-04-01T00:00:00Z').getTime() / 1000);

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);

  /**
   * Preiscache:
   *   ERC20:          "{network}:{contractAddress}:{YYYY-MM-DD}" → {usd, eur}
   *   Native/Binance: "SYMBOL:{symbol}:{YYYY-MM-DD}"            → {usd, eur}
   */
  private readonly cache = new Map<string, { usd: number; eur: number }>();

  /**
   * Tracking welche Tokens bereits (versucht) geladen wurden.
   *   ERC20:          "{network}:{contractAddress}"
   *   Native/Binance: "SYMBOL:{symbol}"
   */
  private readonly fetchedTokens = new Set<string>();

  /** Tokens ohne Preisdaten auf Alchemy → potenzieller Spam */
  private readonly spamTokens = new Set<string>();

  private readonly eurUsdRate = parseFloat(process.env.EUR_USD_RATE ?? '0.92');

  // ─── Öffentliche API ──────────────────────────────────────────────────────────

  /**
   * Preis eines On-Chain ERC20-Tokens über Netzwerk + Kontraktadresse.
   * Beim ersten Aufruf wird die gesamte Tagespreishistorie gecacht.
   *
   * @param network     Alchemy-Netzwerkname, z.B. 'bnb-mainnet', 'arb-mainnet'
   * @param contractAddress  Token-Kontraktadresse (lowercase empfohlen)
   * @param symbol      Für Spam-Logs und Stablecoin-Check
   * @param date        Zeitpunkt des Transfers
   */
  async getPriceByAddress(
    network: string,
    contractAddress: string,
    symbol: string,
    date: Date,
  ): Promise<{ usd: number; eur: number }> {
    const sym = symbol.toUpperCase();
    if (STABLECOINS.has(sym)) return { usd: 1.0, eur: this.eurUsdRate };

    const tokenKey = this.addressKey(network, contractAddress);

    if (this.spamTokens.has(tokenKey)) return { usd: 0, eur: 0 };

    if (!this.fetchedTokens.has(tokenKey)) {
      await this.fetchHistoryByAddress(network, contractAddress, sym);
    }

    if (this.spamTokens.has(tokenKey)) return { usd: 0, eur: 0 };

    const dateKey = this.toDateKey(date);
    return (
      this.cache.get(`${tokenKey}:${dateKey}`) ??
      this.findClosestEarlierPrice(tokenKey, date) ?? { usd: 0, eur: 0 }
    );
  }

  /**
   * Preis eines nativen Tokens oder Binance-Assets über Symbol.
   * Verwenden für: native Coins (ETH, BNB, MATIC) und Binance-Trades.
   *
   * @param symbol  Token-Symbol, z.B. 'ETH', 'BNB'
   * @param date    Zeitpunkt des Transfers
   */
  async getPrice(symbol: string, date: Date): Promise<{ usd: number; eur: number }> {
    const sym = symbol.toUpperCase();
    if (STABLECOINS.has(sym)) return { usd: 1.0, eur: this.eurUsdRate };

    const tokenKey = this.symbolKey(sym);

    if (this.spamTokens.has(tokenKey)) return { usd: 0, eur: 0 };

    if (!this.fetchedTokens.has(tokenKey)) {
      await this.fetchHistoryBySymbol(sym);
    }

    if (this.spamTokens.has(tokenKey)) return { usd: 0, eur: 0 };

    const dateKey = this.toDateKey(date);
    return (
      this.cache.get(`${tokenKey}:${dateKey}`) ??
      this.findClosestEarlierPrice(tokenKey, date) ?? { usd: 0, eur: 0 }
    );
  }

  // ─── History-Fetch ────────────────────────────────────────────────────────────

  /**
   * Lädt Tagespreise via POST /tokens/by-address.
   *
   * Alchemy liefert bei diesem Endpoint nur den aktuellen Preis, keine History.
   * Daher: Batch-Fetch des aktuellen Preises → für den heutigen Tag cachen.
   * Für historische Daten (vergangene Transfers) greift der Symbol-Fallback.
   *
   * Hinweis: Falls Alchemy in Zukunft einen historischen by-address Endpoint
   * anbietet, diesen hier ergänzen.
   */
  private async fetchHistoryByAddress(
    network: string,
    contractAddress: string,
    symbol: string,
  ): Promise<void> {
    const tokenKey = this.addressKey(network, contractAddress);
    this.fetchedTokens.add(tokenKey);

    const apiKey = process.env.ALCHEMY_API_KEY ?? '';
    if (!apiKey) {
      this.logger.warn(`ALCHEMY_API_KEY nicht gesetzt — Preis für ${symbol} (${network}:${contractAddress}) übersprungen`);
      return;
    }

    try {
      const { data } = await axios.post(
        `${PRICES_BASE}/${apiKey}/tokens/by-address`,
        {
          addresses: [{ network, address: contractAddress }],
        },
        { timeout: 15_000 },
      );

      const entry = (data?.data ?? [])[0];

      if (!entry || entry.error || !entry.prices?.length) {
        this.logger.warn(
          `Kein Preis für "${symbol}" (${network}:${contractAddress}) — als potenziellen Spam markiert` +
            (entry?.error ? ` (${entry.error})` : ''),
        );
        this.spamTokens.add(tokenKey);
        return;
      }

      // Aktuellen Preis für heute cachen
      const usdEntry = entry.prices.find((p: any) => p.currency === 'usd');
      if (usdEntry) {
        const usd = parseFloat(usdEntry.value ?? '0');
        const todayKey = this.toDateKey(new Date());
        this.cache.set(`${tokenKey}:${todayKey}`, { usd, eur: usd * this.eurUsdRate });
      }

      // Zusätzlich: historische Preise über Symbol laden (falls Symbol bekannt)
      const resolvedSymbol: string | undefined = entry.symbol ?? symbol;
      if (resolvedSymbol) {
        await this.fetchHistoryBySymbolIntoKey(resolvedSymbol, tokenKey);
      }

      this.logger.log(`[Price] ${symbol} (${network}:${contractAddress.slice(0, 10)}…): Preishistorie geladen`);
    } catch (err) {
      this.logger.error(
        `Alchemy by-address fehlgeschlagen für ${symbol} (${network}:${contractAddress}): ${(err as Error).message}`,
      );
      this.fetchedTokens.delete(tokenKey); // Retry beim nächsten Sync
    }
  }

  /**
   * Lädt Tagespreishistorie via GET /tokens/historical (symbol-basiert).
   * Verwendet für native Tokens und Binance-Assets.
   */
  private async fetchHistoryBySymbol(symbol: string): Promise<void> {
    const tokenKey = this.symbolKey(symbol);
    this.fetchedTokens.add(tokenKey);
    await this.fetchHistoryBySymbolIntoKey(symbol, tokenKey);
  }

  /**
   * Gemeinsame Implementierung des historischen Fetches.
   * Schreibt in einen beliebigen tokenKey — damit ERC20-Tokens
   * ihren Cache-Key (network:address) behalten, aber trotzdem den
   * symbol-basierten History-Endpoint nutzen können.
   */
  private async fetchHistoryBySymbolIntoKey(
    symbol: string,
    tokenKey: string,
  ): Promise<void> {
    const apiKey = process.env.ALCHEMY_API_KEY ?? '';
    if (!apiKey) return;

    const endTime = Math.floor(Date.now() / 1000);

    try {
      const { data } = await axios.get(
        `${PRICES_BASE}/${apiKey}/tokens/historical`,
        {
          params: {
            symbol,
            startTime: HISTORY_START_UNIX,
            endTime,
            interval: '1d',
          },
          timeout: 15_000,
        },
      );

      const history: Array<{ timestamp: string; value?: string; close?: string }> =
        data?.data?.history ?? [];

      if (history.length === 0) {
        if (!this.spamTokens.has(tokenKey)) {
          this.logger.warn(
            `Kein Preisverlauf für "${symbol}" auf Alchemy — als potenziellen Spam markiert`,
          );
          this.spamTokens.add(tokenKey);
        }
        return;
      }

      let cached = 0;
      for (const point of history) {
        const usd = parseFloat(point.value ?? point.close ?? '0');
        if (!isFinite(usd) || usd <= 0) continue;
        const dateKey = point.timestamp.slice(0, 10);
        this.cache.set(`${tokenKey}:${dateKey}`, { usd, eur: usd * this.eurUsdRate });
        cached++;
      }

      this.logger.log(`[Price] ${symbol} → ${tokenKey}: ${cached} Tageskurse gecacht`);
    } catch (err) {
      this.logger.error(
        `Alchemy historical fehlgeschlagen für "${symbol}": ${(err as Error).message}`,
      );
      // Kein Spam-Flag — könnte transienter Fehler sein
    }
  }

  // ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

  private findClosestEarlierPrice(
    tokenKey: string,
    date: Date,
  ): { usd: number; eur: number } | null {
    const targetMs = date.getTime();
    const prefix = `${tokenKey}:`;
    let bestPrice: { usd: number; eur: number } | null = null;
    let bestDelta = Infinity;

    for (const [key, price] of this.cache.entries()) {
      if (!key.startsWith(prefix)) continue;
      const keyMs = new Date(key.slice(prefix.length)).getTime();
      const delta = targetMs - keyMs;
      if (delta >= 0 && delta < bestDelta) {
        bestDelta = delta;
        bestPrice = price;
      }
    }

    return bestPrice;
  }

  private addressKey(network: string, contractAddress: string): string {
    return `${network}:${contractAddress.toLowerCase()}`;
  }

  private symbolKey(symbol: string): string {
    return `SYMBOL:${symbol.toUpperCase()}`;
  }

  private toDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
