import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { SpamTokenService, SpamStatus } from '../spam-token/spam-token.service';

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


const PRICES_BASE = 'https://api.g.alchemy.com/prices/v1';

const HISTORY_START_UNIX = Math.floor(
  new Date('2025-04-01T00:00:00Z').getTime() / 1000,
);

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);

  /**
   * In-Memory-Lese-Cache: wird beim ersten Zugriff pro Token aus der DB befüllt.
   * Key: "{tokenKey}:{YYYY-MM-DD}" → { usd, eur }
   * Bleibt für die gesamte Prozesslaufzeit erhalten — historische Preise ändern sich nicht.
   */
  private readonly cache = new Map<string, { usd: number; eur: number }>();

  /**
   * Welche tokenKeys wurden bereits aus der DB in den Cache geladen.
   * Verhindert wiederholte DB-Selects pro Token innerhalb eines Prozesslaufs.
   */
  private readonly loadedTokens = new Set<string>();

  /**
   * Bis zu welchem Datum die History eines Tokens zuletzt von der Alchemy API
   * gefetcht wurde. Verhindert Re-Entranz und mehrfache API-Calls pro Tag.
   */
  private readonly fetchedUntil = new Map<string, string>();

  /** Spam-Status-Cache: einmal pro Sync aus der DB geladen. */
  private readonly spamCache = new Map<string, SpamStatus | null>();

  private readonly eurUsdRate = parseFloat(process.env.EUR_USD_RATE ?? '0.92');

  constructor(
    private readonly prisma: PrismaService,
    private readonly spamTokenService: SpamTokenService,
  ) {}

  // ─── Sync-Lifecycle ───────────────────────────────────────────────────────────

  resetForSync(): void {
    this.spamCache.clear();
    this.logger.log('[Price] Spam-Cache zurückgesetzt — starte frischen Sync');
  }

  // ─── Öffentliche API ──────────────────────────────────────────────────────────

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

  async getPrice(
    symbol: string,
    date: Date,
  ): Promise<{ usd: number; eur: number }> {
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
    // 1. Spam-Status prüfen
    if (!this.spamCache.has(tokenKey)) {
      const status = await this.spamTokenService.getStatus(tokenKey);
      this.spamCache.set(tokenKey, status);
    }
    if (this.spamCache.get(tokenKey) === 'SPAM') {
      return { usd: 0, eur: 0 };
    }

    // 2. DB-Preise in Cache laden (einmalig pro Token pro Prozesslauf)
    await this.loadFromDb(tokenKey);

    // 3. Fehlende Tage von Alchemy nachladen (maximal einmal pro Token pro Tag)
    const today = this.toDateKey(new Date());
    if (this.fetchedUntil.get(tokenKey) !== today) {
      await fetch();
    }

    // 4. Cache-Lookup: exakter Treffer oder nächstgelegener früherer Kurs
    const dateKey = this.toDateKey(date);
    return (
      this.cache.get(`${tokenKey}:${dateKey}`) ??
      this.findClosestEarlierPrice(tokenKey, date) ?? { usd: 0, eur: 0 }
    );
  }

  // ─── DB-Persistenz ────────────────────────────────────────────────────────────

  private async loadFromDb(tokenKey: string): Promise<void> {
    if (this.loadedTokens.has(tokenKey)) return;
    this.loadedTokens.add(tokenKey);

    const rows = await this.prisma.tokenPrice.findMany({
      where: { tokenKey },
      select: { date: true, priceUsd: true },
    });

    for (const row of rows) {
      this.cache.set(`${tokenKey}:${row.date}`, {
        usd: row.priceUsd,
        eur: row.priceUsd * this.eurUsdRate,
      });
    }
  }

  private async saveToDb(
    tokenKey: string,
    prices: Array<{ date: string; usd: number }>,
  ): Promise<void> {
    if (prices.length === 0) return;
    await this.prisma.tokenPrice.createMany({
      data: prices.map((p) => ({ tokenKey, date: p.date, priceUsd: p.usd })),
      skipDuplicates: true,
    });
  }

  // ─── History-Fetches ─────────────────────────────────────────────────────────

  private async fetchHistoryByAddress(
    network: string,
    contractAddress: string,
    symbol: string,
    tokenKey: string,
  ): Promise<void> {
    const today = this.toDateKey(new Date());
    this.fetchedUntil.set(tokenKey, today);

    const apiKey = process.env.ALCHEMY_API_KEY ?? '';
    if (!apiKey) {
      this.logger.warn(
        `ALCHEMY_API_KEY nicht gesetzt — Preis für ${symbol} übersprungen`,
      );
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
        await this.spamTokenService.markAsSpam(tokenKey, {
          symbol,
          network,
          contractAddress,
        });
        this.spamCache.set(tokenKey, 'SPAM');
        return;
      }

      await this.spamTokenService.removeIfSpam(tokenKey);
      this.spamCache.delete(tokenKey);

      // Vollständige Preishistorie via Symbol laden — schreibt alle Tage in DB.
      // fetchedUntil löschen damit fetchHistoryBySymbolIntoKey nicht überspringt.
      this.fetchedUntil.delete(tokenKey);
      const resolvedSymbol: string = entry.symbol ?? symbol;
      await this.fetchHistoryBySymbolIntoKey(resolvedSymbol, tokenKey);

      // Fallback: heutiger Preis aus by-address, falls die History-API ihn noch
      // nicht enthält (API-seitiger Verzug von bis zu ~24h).
      if (!this.cache.has(`${tokenKey}:${today}`)) {
        const usdEntry = entry.prices.find((p: any) => p.currency === 'usd');
        if (usdEntry) {
          const usd = parseFloat(usdEntry.value ?? '0');
          this.setCache(tokenKey, today, usd);
          await this.saveToDb(tokenKey, [{ date: today, usd }]);
        }
      }
    } catch (err) {
      this.logger.error(
        `Alchemy by-address fehlgeschlagen für ${symbol} (${network}:${contractAddress}): ${(err as Error).message}`,
      );
      this.fetchedUntil.delete(tokenKey);
    }
  }

  private async fetchHistoryBySymbolIntoKey(
    symbol: string,
    tokenKey: string,
  ): Promise<void> {
    const today = this.toDateKey(new Date());
    this.fetchedUntil.set(tokenKey, today);

    const apiKey = process.env.ALCHEMY_API_KEY ?? '';
    if (!apiKey) return;

    const totalEnd = Math.floor(Date.now() / 1000);
    const totalStart = this.getIncrementalStartTime(tokenKey);

    if (totalStart > totalEnd) {
      this.logger.log(`[Price] ${symbol}: Cache aktuell — kein API-Call nötig`);
      return;
    }

    // Alchemy limitiert die History-Range pro Request — 90-Tage-Chunks vermeiden 400-Fehler
    const CHUNK_SECS = 90 * 24 * 60 * 60;
    const newPrices: Array<{ date: string; usd: number }> = [];
    let anyData = false;

    for (
      let chunkStart = totalStart;
      chunkStart <= totalEnd;
      chunkStart += CHUNK_SECS + 1
    ) {
      const chunkEnd = Math.min(chunkStart + CHUNK_SECS, totalEnd);

      try {
        const { data } = await axios.get(
          `${PRICES_BASE}/${apiKey}/tokens/historical`,
          {
            params: {
              symbol,
              startTime: chunkStart,
              endTime: chunkEnd,
              interval: '1d',
            },
            timeout: 15_000,
          },
        );

        const history: Array<{ timestamp: string; value?: string; close?: string }> =
          data?.data?.history ?? [];

        for (const point of history) {
          const usd = parseFloat(point.value ?? point.close ?? '0');
          if (!isFinite(usd) || usd <= 0) continue;
          const dateKey = point.timestamp.slice(0, 10);
          this.setCache(tokenKey, dateKey, usd);
          newPrices.push({ date: dateKey, usd });
          anyData = true;
        }
      } catch (err: any) {
        const status: number | undefined = err?.response?.status;

        if (status === 400) {
          this.logger.warn(
            `[Price] ${symbol}: Alchemy historical 400 — Symbol nicht unterstützt. ${JSON.stringify(err?.response?.data ?? {})}`,
          );
          // fetchedUntil bleibt auf today gesetzt → kein Re-Retry im selben Prozesslauf
          // Symbol grundsätzlich nicht abrufbar → als Spam markieren wenn keine Daten vorliegen
          const hasExistingData = this.getLastCachedDate(tokenKey) !== null;
          if (!hasExistingData) {
            const currentStatus = this.spamCache.get(tokenKey);
            if (currentStatus !== 'WHITELISTED') {
              const dbStatus =
                currentStatus === undefined
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

        this.logger.error(
          `Alchemy historical fehlgeschlagen für "${symbol}" [chunk ${new Date(chunkStart * 1000).toISOString().slice(0, 10)}]: ${(err as Error).message}`,
        );
        // Bei Netzwerkfehlern fetchedUntil zurücksetzen → Retry beim nächsten Sync
        this.fetchedUntil.delete(tokenKey);
        return;
      }
    }

    if (!anyData) {
      const hasExistingData = this.getLastCachedDate(tokenKey) !== null;
      if (!hasExistingData) {
        const currentStatus = this.spamCache.get(tokenKey);
        if (currentStatus !== 'WHITELISTED') {
          const dbStatus =
            currentStatus === undefined
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
    await this.saveToDb(tokenKey, newPrices);

    const startLabel = new Date(totalStart * 1000).toISOString().slice(0, 10);
    this.logger.log(
      `[Price] ${symbol}: ${newPrices.length} Tageskurse gespeichert (${startLabel} – ${today})`,
    );
  }

  // ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

  private getIncrementalStartTime(tokenKey: string): number {
    const lastDate = this.getLastCachedDate(tokenKey);
    if (!lastDate) return HISTORY_START_UNIX;

    const nextDay = new Date(`${lastDate}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    return Math.floor(nextDay.getTime() / 1000);
  }

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
    this.cache.set(`${tokenKey}:${dateKey}`, {
      usd,
      eur: usd * this.eurUsdRate,
    });
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
