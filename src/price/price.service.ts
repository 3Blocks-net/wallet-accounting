import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const STABLECOINS = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'FRAX', 'PYUSD',
]);

const COINGECKO_IDS: Record<string, string> = {
  ETH: 'ethereum',
  WETH: 'weth',
  BTC: 'bitcoin',
  WBTC: 'wrapped-bitcoin',
  BNB: 'binancecoin',
  WBNB: 'wbnb',
  MATIC: 'matic-network',
  POL: 'matic-network',
  ARB: 'arbitrum',
  OP: 'optimism',
  LINK: 'chainlink',
  UNI: 'uniswap',
  AAVE: 'aave',
  CRV: 'curve-dao-token',
  MKR: 'maker',
  SNX: 'havven',
  COMP: 'compound-governance-token',
  SUSHI: 'sushi',
  '1INCH': '1inch',
};

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);
  private readonly cache = new Map<string, { usd: number; eur: number }>();

  async getPrice(symbol: string, date: Date): Promise<{ usd: number; eur: number }> {
    const sym = symbol.toUpperCase();

    if (STABLECOINS.has(sym)) {
      // EUR/USD-Kurs für Stablecoins ist näherungsweise 1:0.92
      // TODO: Historischen EUR/USD-Kurs via CoinGecko für 'tether' laden
      return { usd: 1.0, eur: 0.92 };
    }

    const dateStr = this.toCoinGeckoDate(date);
    const cacheKey = `${sym}:${dateStr}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const cgId = COINGECKO_IDS[sym];
    if (!cgId) {
      this.logger.warn(`Kein CoinGecko-ID für Symbol "${symbol}" — Preis wird auf 0 gesetzt`);
      return { usd: 0, eur: 0 };
    }

    try {
      await this.delay(300); // Free-Tier: max ~30 req/min

      const headers: Record<string, string> = {};
      if (process.env.COINGECKO_API_KEY) {
        headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
      }

      const { data } = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${cgId}/history`,
        {
          params: { date: dateStr, localization: false },
          headers,
          timeout: 10_000,
        },
      );

      const price = {
        usd: data.market_data?.current_price?.usd ?? 0,
        eur: data.market_data?.current_price?.eur ?? 0,
      };

      this.cache.set(cacheKey, price);
      return price;
    } catch (err) {
      this.logger.error(
        `CoinGecko-Preisabfrage fehlgeschlagen für ${sym} am ${dateStr}: ${(err as Error).message}`,
      );
      return { usd: 0, eur: 0 };
    }
  }

  /** CoinGecko erwartet das Format DD-MM-YYYY */
  private toCoinGeckoDate(date: Date): string {
    const d = String(date.getUTCDate()).padStart(2, '0');
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${d}-${m}-${date.getUTCFullYear()}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
