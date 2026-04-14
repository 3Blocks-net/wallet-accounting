import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { SpamTokenService, SpamStatus } from '../spam-token/spam-token.service';

const STABLECOINS = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'FRAX', 'PYUSD',
]);

/**
 * Native tokens die Alchemy nicht per Symbol auflösen kann.
 * Fallback: historische Preise über die Wrapped-Token-Adresse laden.
 * WBNB == BNB im Preis; WMATIC == MATIC etc.
 */
const NATIVE_FALLBACK_ADDRESSES: Record<string, { network: string; address: string }> = {
  BNB:   { network: 'bnb-mainnet',     address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  WBNB:  { network: 'bnb-mainnet',     address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  MATIC: { network: 'polygon-mainnet', address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270' },
  WMATIC:{ network: 'polygon-mainnet', address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270' },
};

const PRICES_BASE = 'https://api.g.alchemy.com/prices/v1';

/** Startdatum für Preishistorie — kurz vor Firmengründung */
const HISTORY_START_UNIX = Math.floor(new Date('2025-04-01T00:00:00Z').getTime() / 1000);

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);

  /**
   * In-Memory-Preiscache:
   *   ERC20:          "{network}:{contractAddress}:{YYYY-MM-DD}" → {usd, eur}
   *   Native/Binance: "SYMBOL:{symbol}:{YYYY-MM-DD}"            → {usd, eur}
   *
   * Bleibt dauerhaft erhalten — historische Preise ändern sich nicht.
   * Neue Tageskurse werden beim nächsten Sync inkrementell ergänzt.
   */
  private readonly cache = new Map<string, { usd: number; eur: number }>();

  /**
   * Tracks bis zu welchem Datum die History eines Tokens zuletzt geladen wurde.
   *   tokenKey → "YYYY-MM-DD"
   *
   * Wird NICHT durch resetForSync() geleert — historische Preise ändern sich nicht.
   * Ein Token wird täglich maximal einmal neu gefetcht (inkrementell: nur neue Tage).
   *
   * Wird auf null gesetzt wenn ein Fetch fehlschlägt → erneuter Versuch beim nächsten Aufruf.
   */
  private readonly fetchedUntil = new Map<string, string>();

  /**
   * Spam-Status-Cache: verhindert einen DB-Query pro Preis-Lookup.
   * Wird durch resetForSync() geleert — lädt DB-Status frisch pro Sync.
   */
  private readonly spamCache = new Map<string, SpamStatus | null>();

  private readonly eurUsdRate = parseFloat(process.env.EUR_USD_RATE ?? '0.92');

  constructor(private readonly spamTokenService: SpamTokenService) {}

  // ─── Sync-Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Muss zu Beginn jedes Sync-Laufs aufgerufen werden.
   *
   * Warum nur spamCache leeren?
   *   - DB-Spam-Status kann sich geändert haben (Whitelist / Re-Mark)
   *   - fetchedUntil bleibt erhalten: ein Token wird pro Kalendertag maximal einmal
   *     neu gefetcht (inkrementell), egal wie viele Syncs laufen.
   *
   * Der Preiscache (this.cache) bleibt erhalten — historische Kurse ändern
   * sich nicht, neue Punkte werden täglich inkrementell ergänzt.
   */
  resetForSync(): void {
    this.spamCache.clear();
    this.logger.log('[Price] Spam-Cache zurückgesetzt — starte frischen Sync');
  }

  // ─── Öffentliche API ──────────────────────────────────────────────────────────

  /**
   * Preis eines ERC20-Tokens über Netzwerk + Kontraktadresse.
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
    return this.resolvePrice(tokenKey, date, () =>
      this.fetchHistoryByAddress(network, contractAddress, sym, tokenKey),
    );
  }

  /**
   * Preis eines nativen Tokens oder Binance-Assets über Symbol.
   */
  async getPrice(symbol: string, date: Date): Promise<{ usd: number; eur: number }> {
    const sym = symbol.toUpperCase();
    if (STABLECOINS.has(sym)) return { usd: 1.0, eur: this.eurUsdRate };

    const tokenKey = this.symbolKey(sym);
    return this.resolvePrice(tokenKey, date, () =>
      this.fetchHistoryBySymbolIntoKey(sym, tokenKey),
    );
  }

  // ─── Gemeinsame Auflösungslogik ───────────────────────────────────────────────

  private async resolvePrice(
    tokenKey: string,
    date: Date,
    fetch: () => Promise<void>,
  ): Promise<{ usd: number; eur: number }> {
    // 1. Spam-Status: erst In-Memory-Cache, dann DB (einmal pro Token pro Sync)
    if (!this.spamCache.has(tokenKey)) {
      const status = await this.spamTokenService.getStatus(tokenKey);
      this.spamCache.set(tokenKey, status);
    }
    if (this.spamCache.get(tokenKey) === 'SPAM') {
      return { usd: 0, eur: 0 };
    }

    // 2. History laden — maximal einmal pro Token pro Kalendertag
    const today = this.toDateKey(new Date());
    if (this.fetchedUntil.get(tokenKey) !== today) {
      await fetch();
    }

    // 3. Cache-Lookup: exakter Datumstreffer oder nächstgelegener früherer Kurs
    const dateKey = this.toDateKey(date);
    return (
      this.cache.get(`${tokenKey}:${dateKey}`) ??
      this.findClosestEarlierPrice(tokenKey, date) ??
      { usd: 0, eur: 0 }
    );
  }

  // ─── History-Fetches ─────────────────────────────────────────────────────────

  private async fetchHistoryByAddress(
    network: string,
    contractAddress: string,
    symbol: string,
    tokenKey: string,
  ): Promise<void> {
    // Sofort markieren — verhindert Re-Entranz bei parallelen Aufrufen
    const today = this.toDateKey(new Date());
    this.fetchedUntil.set(tokenKey, today);

    const apiKey = process.env.ALCHEMY_API_KEY ?? '';
    if (!apiKey) {
      this.logger.warn(`ALCHEMY_API_KEY nicht gesetzt — Preis für ${symbol} übersprungen`);
      return;
    }

    try {
      const { data } = await axios.post(
        `${PRICES_BASE}/${apiKey}/tokens/by-address`,
        { addresses: [{ network, address: contractAddress }] },
        { timeout: 15_000 },
      );

      const entry = (data?.data ?? [])[0];

      if (!entry || entry.error || !entry.prices?.length) {
        await this.spamTokenService.markAsSpam(tokenKey, { symbol, network, contractAddress });
        this.spamCache.set(tokenKey, 'SPAM');
        return;
      }

      // Aktuellen Preis für heute cachen
      const usdEntry = entry.prices.find((p: any) => p.currency === 'usd');
      if (usdEntry) {
        const usd = parseFloat(usdEntry.value ?? '0');
        this.setCache(tokenKey, today, usd);
      }

      await this.spamTokenService.removeIfSpam(tokenKey);
      this.spamCache.delete(tokenKey); // frisch aus DB laden beim nächsten Zugriff

      // Historische Tagespreise via Symbol nachladen
      // fetchedUntil für diesen Key freigeben, damit fetchHistoryBySymbolIntoKey inkrementell lädt
      this.fetchedUntil.delete(tokenKey);
      const resolvedSymbol: string = entry.symbol ?? symbol;
      await this.fetchHistoryBySymbolIntoKey(resolvedSymbol, tokenKey);
    } catch (err) {
      this.logger.error(
        `Alchemy by-address fehlgeschlagen für ${symbol} (${network}:${contractAddress}): ${(err as Error).message}`,
      );
      this.fetchedUntil.delete(tokenKey); // erneuter Versuch beim nächsten Aufruf
    }
  }

  private async fetchHistoryBySymbolIntoKey(
    symbol: string,
    tokenKey: string,
  ): Promise<void> {
    const today = this.toDateKey(new Date());
    // Sofort markieren — verhindert Re-Entranz bei parallelen Aufrufen
    this.fetchedUntil.set(tokenKey, today);

    const apiKey = process.env.ALCHEMY_API_KEY ?? '';
    if (!apiKey) return;

    const endTime = Math.floor(Date.now() / 1000);

    // Inkrementeller Fetch: nur Tage laden die noch nicht im Cache sind
    const startTime = this.getIncrementalStartTime(tokenKey);

    // Cache ist bereits aktuell — kein API-Call nötig
    if (startTime > endTime) {
      this.logger.log(`[Price] ${symbol}: Cache aktuell — kein API-Call nötig`);
      return;
    }

    try {
      const { data } = await axios.get(
        `${PRICES_BASE}/${apiKey}/tokens/historical`,
        {
          params: { symbol, startTime, endTime, interval: '1d' },
          timeout: 15_000,
        },
      );

      const history: Array<{ timestamp: string; value?: string; close?: string }> =
        data?.data?.history ?? [];

      if (history.length === 0) {
        // Nur als Spam markieren wenn wir noch gar keine Daten haben
        const hasExistingData = this.getLastCachedDate(tokenKey) !== null;
        if (!hasExistingData) {
          const currentStatus = this.spamCache.get(tokenKey);
          if (currentStatus !== 'WHITELISTED') {
            const dbStatus = currentStatus === undefined
              ? await this.spamTokenService.getStatus(tokenKey)
              : currentStatus;
            if (dbStatus !== 'WHITELISTED') {
              await this.spamTokenService.markAsSpam(tokenKey, { symbol });
              this.spamCache.set(tokenKey, 'SPAM');
            }
          }
        }
        return;
      }

      await this.spamTokenService.removeIfSpam(tokenKey);
      this.spamCache.delete(tokenKey);

      let cached = 0;
      for (const point of history) {
        const usd = parseFloat(point.value ?? point.close ?? '0');
        if (!isFinite(usd) || usd <= 0) continue;
        this.setCache(tokenKey, point.timestamp.slice(0, 10), usd);
        cached++;
      }

      const startLabel = new Date(startTime * 1000).toISOString().slice(0, 10);
      this.logger.log(`[Price] ${symbol}: ${cached} neue Tageskurse geladen (${startLabel} – ${today})`);
    } catch (err: any) {
      const status: number | undefined = err?.response?.status;

      if (status === 400) {
        // Alchemy kennt dieses Symbol nicht — Fallback via Adresse versuchen
        const fallback = NATIVE_FALLBACK_ADDRESSES[symbol];
        if (fallback) {
          this.logger.log(
            `[Price] ${symbol}: Symbol von Alchemy abgelehnt (400) — Fallback via ${fallback.network}:${fallback.address}`,
          );
          this.fetchedUntil.delete(tokenKey);
          await this.fetchHistoryByAddress(fallback.network, fallback.address, symbol, tokenKey);
        } else {
          this.logger.warn(
            `[Price] ${symbol}: Von Alchemy nicht unterstützt (400) — kein Preis verfügbar. Kein Fallback konfiguriert.`,
          );
          // fetchedUntil gesetzt lassen → kein Retry heute
        }
      } else {
        // Transienter Fehler → beim nächsten Aufruf erneut versuchen
        this.logger.error(
          `Alchemy historical fehlgeschlagen für "${symbol}": ${(err as Error).message}`,
        );
        this.fetchedUntil.delete(tokenKey);
      }
    }
  }

  // ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

  /**
   * Gibt den Unix-Timestamp für den Start des inkrementellen Fetches zurück.
   * Wenn noch kein Cache-Eintrag existiert → volle History ab HISTORY_START_UNIX.
   * Sonst → Tag nach dem letzten gecachten Datum.
   */
  private getIncrementalStartTime(tokenKey: string): number {
    const lastDate = this.getLastCachedDate(tokenKey);
    if (!lastDate) return HISTORY_START_UNIX;

    const nextDay = new Date(`${lastDate}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    return Math.floor(nextDay.getTime() / 1000);
  }

  /**
   * Gibt das späteste gecachte Datum für einen Token zurück, oder null.
   */
  private getLastCachedDate(tokenKey: string): string | null {
    const prefix = `${tokenKey}:`;
    let latest: string | null = null;
    for (const key of this.cache.keys()) {
      if (!key.startsWith(prefix)) continue;
      const dateKey = key.slice(prefix.length);
      if (!latest || dateKey > latest) latest = dateKey;
    }
    return latest;
  }

  private setCache(tokenKey: string, dateKey: string, usd: number): void {
    this.cache.set(`${tokenKey}:${dateKey}`, { usd, eur: usd * this.eurUsdRate });
  }

  private findClosestEarlierPrice(
    tokenKey: string,
    date: Date,
  ): { usd: number; eur: number } | null {
    const targetMs = date.getTime();
    const prefix = `${tokenKey}:`;
    let best: { usd: number; eur: number } | null = null;
    let bestDelta = Infinity;

    for (const [key, price] of this.cache.entries()) {
      if (!key.startsWith(prefix)) continue;
      const delta = targetMs - new Date(key.slice(prefix.length)).getTime();
      if (delta >= 0 && delta < bestDelta) {
        bestDelta = delta;
        best = price;
      }
    }
    return best;
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
