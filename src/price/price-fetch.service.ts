import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADDRESS_BATCH_SIZE,
  FIAT_CURRENCIES,
  FetchMode,
  FetchResult,
  HISTORY_CHUNK_DAYS,
  HISTORY_START_DATE,
  MissingToken,
  NETWORK_TO_ALCHEMY,
  STABLECOINS,
} from './token-mapping';

const PRICES_BASE = 'https://api.g.alchemy.com/prices/v1';

@Injectable()
export class PriceFetchService {
  private readonly logger = new Logger(PriceFetchService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  async getMissingTokens(): Promise<MissingToken[]> {
    const transfers = await this.prisma.transfer.findMany({
      where: { priceUsd: '0' },
      select: {
        asset: true,
        tokenAddress: true,
        transaction: { select: { network: true } },
      },
    });

    const tokenMap = new Map<
      string,
      {
        symbol: string;
        tokenAddress?: string;
        network?: string;
        alchemyNetwork?: string;
        fetchMode: FetchMode;
        count: number;
      }
    >();

    for (const t of transfers) {
      const symbol = t.asset.toUpperCase();
      if (STABLECOINS.has(symbol) || FIAT_CURRENCIES.has(symbol)) continue;

      const network = t.transaction.network.toUpperCase();
      const alchemyNetwork = NETWORK_TO_ALCHEMY[network];
      const hasAddress = !!t.tokenAddress && t.tokenAddress !== '';
      const fetchMode: FetchMode =
        hasAddress && alchemyNetwork ? 'address' : 'symbol';

      const tokenKey =
        fetchMode === 'address'
          ? `${alchemyNetwork}:${t.tokenAddress!.toLowerCase()}`
          : `SYMBOL:${symbol}`;

      if (!tokenMap.has(tokenKey)) {
        tokenMap.set(tokenKey, {
          symbol,
          tokenAddress: hasAddress ? t.tokenAddress! : undefined,
          network: hasAddress ? network : undefined,
          alchemyNetwork: hasAddress ? alchemyNetwork : undefined,
          fetchMode,
          count: 0,
        });
      }
      tokenMap.get(tokenKey)!.count++;
    }

    const spamEntries = await this.prisma.spamToken.findMany({
      where: { tokenKey: { in: [...tokenMap.keys()] } },
      select: { tokenKey: true, status: true },
    });
    const spamMap = new Map(spamEntries.map((s) => [s.tokenKey, s.status]));

    return [...tokenMap.entries()].map(([tokenKey, info]) => ({
      tokenKey,
      symbol: info.symbol,
      tokenAddress: info.tokenAddress,
      network: info.network,
      alchemyNetwork: info.alchemyNetwork,
      fetchMode: info.fetchMode,
      affectedTransfers: info.count,
      isSpam: spamMap.get(tokenKey) === 'SPAM',
    }));
  }

  async fetchMissingPrices(): Promise<FetchResult> {
    const apiKey = process.env.ALCHEMY_API_KEY ?? '';
    if (!apiKey) throw new Error('ALCHEMY_API_KEY not set');

    const missing = await this.getMissingTokens();
    const toFetch = missing.filter((t) => !t.isSpam);

    const addressTokens = toFetch.filter((t) => t.fetchMode === 'address');
    const symbolTokens = toFetch.filter((t) => t.fetchMode === 'symbol');

    let fetched = 0;
    let spam = 0;

    // Address-based tokens: batch via by-address, then fetch historical per resolved symbol
    const resolved = await this.resolveAddressBatch(addressTokens, apiKey);
    spam += addressTokens.length - resolved.length;

    for (const { tokenKey, symbol } of resolved) {
      const count = await this.fetchHistoricalBySymbol(
        symbol,
        tokenKey,
        apiKey,
      );
      if (count > 0) fetched++;
      else spam++;
    }

    // Symbol-based tokens: fetch historical directly
    for (const token of symbolTokens) {
      const count = await this.fetchHistoricalBySymbol(
        token.symbol,
        token.tokenKey,
        apiKey,
      );
      if (count > 0) fetched++;
      else spam++;
    }

    this.logger.log(
      `Fetch complete — ${fetched} tokens with prices, ${spam} marked spam`,
    );
    return { fetched, spam };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async resolveAddressBatch(
    tokens: MissingToken[],
    apiKey: string,
  ): Promise<Array<{ tokenKey: string; symbol: string }>> {
    const resolved: Array<{ tokenKey: string; symbol: string }> = [];

    for (let i = 0; i < tokens.length; i += ADDRESS_BATCH_SIZE) {
      const chunk = tokens.slice(i, i + ADDRESS_BATCH_SIZE);

      const addresses = chunk.map((t) => ({
        network: t.alchemyNetwork!,
        address: t.tokenAddress!,
      }));

      // Build lookup map: "{alchemyNetwork}:{address}" → MissingToken
      const chunkMap = new Map(
        chunk.map((t) => [
          `${t.alchemyNetwork}:${t.tokenAddress!.toLowerCase()}`,
          t,
        ]),
      );

      try {
        const { data } = await axios.post(
          `${PRICES_BASE}/${apiKey}/tokens/by-address`,
          { addresses },
          { timeout: 15_000 },
        );

        for (const entry of data?.data ?? []) {
          const key = `${entry.network}:${(entry.address ?? '').toLowerCase()}`;
          const token = chunkMap.get(key);
          if (!token) continue;

          if (entry.error || !entry.prices?.length) {
            await this.markAsSpam(
              token.tokenKey,
              token.symbol,
              token.network,
              token.tokenAddress,
            );
            continue;
          }

          resolved.push({
            tokenKey: token.tokenKey,
            symbol: (entry.symbol as string | undefined) ?? token.symbol,
          });
        }
      } catch (err) {
        this.logger.error(`by-address batch failed: ${(err as Error).message}`);
        // Network error — don't mark as spam, retry next call
      }
    }

    return resolved;
  }

  private async fetchHistoricalBySymbol(
    symbol: string,
    tokenKey: string,
    apiKey: string,
  ): Promise<number> {
    const totalEnd = Math.floor(Date.now() / 1000);
    const totalStart = await this.getIncrementalStart(tokenKey);

    if (totalStart > totalEnd) {
      this.logger.log(`[Price] ${symbol}: already up to date`);
      return 1;
    }

    const CHUNK_SECS = HISTORY_CHUNK_DAYS * 24 * 60 * 60;
    const prices: Array<{ date: string; usd: number }> = [];

    for (let start = totalStart; start <= totalEnd; start += CHUNK_SECS + 1) {
      const end = Math.min(start + CHUNK_SECS, totalEnd);

      try {
        const { data } = await axios.post(
          `${PRICES_BASE}/${apiKey}/tokens/historical`,
          { symbol, startTime: start, endTime: end, interval: '1d' },
          { timeout: 15_000 },
        );

        for (const point of data?.data ?? []) {
          const usd = parseFloat(point.value ?? '0');
          if (!isFinite(usd) || usd <= 0) continue;
          prices.push({ date: (point.timestamp as string).slice(0, 10), usd });
        }
      } catch (err: any) {
        if (err?.response?.status === 400) {
          const body = err?.response?.data ?? {};
          const msg: string =
            body?.error?.message ?? body?.message ?? JSON.stringify(body);
          this.logger.warn(
            `[Price] ${symbol}: Alchemy historical 400 — ${msg}`,
          );
          // Only mark as spam when Alchemy explicitly rejects the symbol.
          // Generic parameter errors (e.g. "startTime is required" returned for
          // unsupported symbols) also arrive as 400, so we treat every 400 as
          // "symbol not supported" and mark accordingly.
          await this.markAsSpam(tokenKey, symbol);
          return 0;
        }
        this.logger.error(
          `[Price] ${symbol}: historical fetch failed: ${(err as Error).message}`,
        );
        return 0;
      }
    }

    if (prices.length === 0) {
      await this.markAsSpam(tokenKey, symbol);
      return 0;
    }

    await this.saveToDb(tokenKey, prices);
    await this.prisma.spamToken.deleteMany({
      where: { tokenKey, status: 'SPAM' },
    });

    this.logger.log(
      `[Price] ${symbol} (${tokenKey}): ${prices.length} daily prices saved`,
    );
    return prices.length;
  }

  private async getIncrementalStart(tokenKey: string): Promise<number> {
    const latest = await this.prisma.tokenPrice.findFirst({
      where: { tokenKey },
      orderBy: { date: 'desc' },
      select: { date: true },
    });

    if (!latest) {
      return Math.floor(
        new Date(`${HISTORY_START_DATE}T00:00:00Z`).getTime() / 1000,
      );
    }

    const nextDay = new Date(`${latest.date}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    return Math.floor(nextDay.getTime() / 1000);
  }

  private async saveToDb(
    tokenKey: string,
    prices: Array<{ date: string; usd: number }>,
  ): Promise<void> {
    await this.prisma.tokenPrice.createMany({
      data: prices.map((p) => ({ tokenKey, date: p.date, priceUsd: p.usd })),
      skipDuplicates: true,
    });
  }

  private async markAsSpam(
    tokenKey: string,
    symbol: string,
    network?: string,
    contractAddress?: string,
  ): Promise<void> {
    const existing = await this.prisma.spamToken.findUnique({
      where: { tokenKey },
      select: { status: true },
    });
    if (existing?.status === 'WHITELISTED') return;

    await this.prisma.spamToken.upsert({
      where: { tokenKey },
      create: { tokenKey, status: 'SPAM', symbol, network, contractAddress },
      update: {},
    });
    this.logger.warn(`[Price] Spam: ${symbol} (${tokenKey})`);
  }
}
