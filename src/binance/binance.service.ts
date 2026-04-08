import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import { PriceService } from '../price/price.service';
import { RawRow } from '../transactions/types';

const BINANCE_BASE_URL = 'https://api.binance.com';

/** Firmenstart Mai 2025 — alle Wallets waren ab dann frisch */
const COMPANY_START_MS = new Date('2025-05-01T00:00:00Z').getTime();

/** Binance API erlaubt max. 90 Tage pro Zeitraum-Anfrage */
const CHUNK_MS = 89 * 24 * 60 * 60 * 1000;

/** Bekannte Quote-Assets für das Parsen von Trading Pairs */
const KNOWN_QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BNB', 'BTC', 'ETH', 'EUR'];

@Injectable()
export class BinanceService {
  private readonly logger = new Logger(BinanceService.name);

  constructor(private readonly priceService: PriceService) {}

  private get apiKey() {
    return process.env.BINANCE_API_KEY ?? '';
  }
  private get secretKey() {
    return process.env.BINANCE_SECRET_KEY ?? '';
  }

  async syncAll(lastSyncedAt?: Date): Promise<RawRow[]> {
    if (!this.apiKey || !this.secretKey) {
      this.logger.warn('BINANCE_API_KEY / BINANCE_SECRET_KEY nicht konfiguriert — Binance-Sync übersprungen');
      return [];
    }

    const startMs = lastSyncedAt ? lastSyncedAt.getTime() : COMPANY_START_MS;
    const endMs = Date.now();

    const [deposits, withdrawals, trades] = await Promise.all([
      this.fetchDeposits(startMs, endMs),
      this.fetchWithdrawals(startMs, endMs),
      this.fetchTrades(startMs, endMs),
    ]);

    return [...deposits, ...withdrawals, ...trades];
  }

  // ─── Deposits ────────────────────────────────────────────────────────────────

  private async fetchDeposits(startMs: number, endMs: number): Promise<RawRow[]> {
    const rows: RawRow[] = [];

    for (const [start, end] of this.timeChunks(startMs, endMs)) {
      try {
        const deposits = await this.signedGet<any[]>('/sapi/v1/capital/deposit/hisrec', {
          startTime: start,
          endTime: end,
          limit: 1000,
        });

        for (const d of deposits) {
          if (d.status !== 1) continue; // nur erfolgreiche Deposits

          const date = new Date(d.insertTime);
          const amount = String(d.amount);
          const prices = await this.priceService.getPrice(d.coin, date);

          rows.push({
            date: date.toISOString(),
            wallet_address: 'BINANCE_WALLET',
            source_type: 'TYPE_BINANCE_DEPOSIT',
            direction: 'IN',
            asset: d.coin,
            amount,
            fee: '0',
            fee_asset: '',
            price_usd: String(prices.usd),
            value_usd: String(Number(amount) * prices.usd),
            price_eur: String(prices.eur),
            value_eur: String(Number(amount) * prices.eur),
            network: d.network || 'BINANCE',
            from_address: d.addressFrom || 'EXTERNAL',
            to_address: 'BINANCE_WALLET',
            tx_hash: d.txId || `BINANCE_DEP:${d.insertTime}:${d.coin}`,
            operation: 'DEPOSIT',
            note: '',
          });
        }
      } catch (err) {
        this.logger.error(`Deposit-Fetch fehlgeschlagen [${start}-${end}]: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Binance Deposits: ${rows.length} Zeilen`);
    return rows;
  }

  // ─── Withdrawals ─────────────────────────────────────────────────────────────

  private async fetchWithdrawals(startMs: number, endMs: number): Promise<RawRow[]> {
    const rows: RawRow[] = [];

    for (const [start, end] of this.timeChunks(startMs, endMs)) {
      try {
        const withdrawals = await this.signedGet<any[]>('/sapi/v1/capital/withdraw/history', {
          startTime: start,
          endTime: end,
          limit: 1000,
        });

        for (const w of withdrawals) {
          if (w.status !== 6) continue; // nur abgeschlossene Auszahlungen

          const date = new Date(w.applyTime);
          const amount = String(w.amount);
          const fee = String(w.transactionFee ?? '0');
          const prices = await this.priceService.getPrice(w.coin, date);

          rows.push({
            date: date.toISOString(),
            wallet_address: 'BINANCE_WALLET',
            source_type: 'TYPE_BINANCE_WITHDRAWAL',
            direction: 'OUT',
            asset: w.coin,
            amount,
            fee,
            fee_asset: w.coin,
            price_usd: String(prices.usd),
            value_usd: String(Number(amount) * prices.usd),
            price_eur: String(prices.eur),
            value_eur: String(Number(amount) * prices.eur),
            network: w.network || 'BINANCE',
            from_address: 'BINANCE_WALLET',
            to_address: w.address,
            tx_hash: w.txId || `BINANCE_WITH:${w.applyTime}:${w.coin}`,
            operation: 'WITHDRAWAL',
            note: '',
          });
        }
      } catch (err) {
        this.logger.error(`Withdrawal-Fetch fehlgeschlagen [${start}-${end}]: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Binance Withdrawals: ${rows.length} Zeilen`);
    return rows;
  }

  // ─── Spot-Trades ─────────────────────────────────────────────────────────────

  private async fetchTrades(startMs: number, endMs: number): Promise<RawRow[]> {
    const pairsEnv = process.env.BINANCE_SPOT_PAIRS ?? '';
    const pairs = pairsEnv
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean);

    if (pairs.length === 0) {
      this.logger.warn(
        'BINANCE_SPOT_PAIRS nicht konfiguriert — Spot-Trade-Sync übersprungen. ' +
          'Beispiel: BINANCE_SPOT_PAIRS=ETHUSDT,BNBUSDT,BTCUSDT',
      );
      return [];
    }

    const rows: RawRow[] = [];

    for (const symbol of pairs) {
      for (const [start, end] of this.timeChunks(startMs, endMs)) {
        try {
          const trades = await this.signedGet<any[]>('/api/v3/myTrades', {
            symbol,
            startTime: start,
            endTime: end,
            limit: 1000,
          });

          for (const trade of trades) {
            const tradeRows = await this.tradeToRawRows(symbol, trade);
            rows.push(...tradeRows);
          }
        } catch (err) {
          this.logger.error(
            `Trade-Fetch fehlgeschlagen für ${symbol} [${start}-${end}]: ${(err as Error).message}`,
          );
        }
      }
    }

    this.logger.log(`Binance Trades: ${rows.length} Zeilen`);
    return rows;
  }

  private async tradeToRawRows(symbol: string, trade: any): Promise<RawRow[]> {
    const parsed = this.parseSymbol(symbol);
    if (!parsed) {
      this.logger.warn(`Symbol "${symbol}" konnte nicht geparst werden`);
      return [];
    }
    const { base, quote } = parsed;

    const date = new Date(trade.time);
    const txHash = `BINANCE_TRADE:${trade.id}`;

    // isBuyer=true → Base gekauft, Quote verkauft
    // isBuyer=false → Base verkauft, Quote gekauft
    const inAsset = trade.isBuyer ? base : quote;
    const outAsset = trade.isBuyer ? quote : base;
    const inAmount = trade.isBuyer ? String(trade.qty) : String(trade.quoteQty);
    const outAmount = trade.isBuyer ? String(trade.quoteQty) : String(trade.qty);

    const [inPrices, outPrices] = await Promise.all([
      this.priceService.getPrice(inAsset, date),
      this.priceService.getPrice(outAsset, date),
    ]);

    const makeRow = (
      direction: 'IN' | 'OUT',
      asset: string,
      amount: string,
      prices: { usd: number; eur: number },
    ): RawRow => ({
      date: date.toISOString(),
      wallet_address: 'BINANCE_WALLET',
      source_type: 'TYPE_BINANCE_TRADE',
      direction,
      asset,
      amount,
      // Kommission wird dem erhaltenen Asset abgezogen wenn commissionAsset==inAsset
      fee:
        direction === 'IN' && trade.commissionAsset === asset
          ? String(trade.commission)
          : '0',
      fee_asset:
        direction === 'IN' && trade.commissionAsset === asset ? asset : '',
      price_usd: String(prices.usd),
      value_usd: String(Number(amount) * prices.usd),
      price_eur: String(prices.eur),
      value_eur: String(Number(amount) * prices.eur),
      network: 'BINANCE',
      from_address: direction === 'OUT' ? 'BINANCE_WALLET' : 'BINANCE_EXCHANGE',
      to_address: direction === 'IN' ? 'BINANCE_WALLET' : 'BINANCE_EXCHANGE',
      tx_hash: txHash,
      operation: 'SPOT_TRADE',
      note: `${symbol} #${trade.id}`,
    });

    return [
      makeRow('IN', inAsset, inAmount, inPrices),
      makeRow('OUT', outAsset, outAmount, outPrices),
    ];
  }

  // ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

  private parseSymbol(symbol: string): { base: string; quote: string } | null {
    for (const q of KNOWN_QUOTES) {
      if (symbol.endsWith(q)) {
        return { base: symbol.slice(0, -q.length), quote: q };
      }
    }
    return null;
  }

  private *timeChunks(startMs: number, endMs: number): Iterable<[number, number]> {
    let current = startMs;
    while (current < endMs) {
      const next = Math.min(current + CHUNK_MS, endMs);
      yield [current, next];
      current = next + 1;
    }
  }

  private sign(queryString: string): string {
    return crypto.createHmac('sha256', this.secretKey).update(queryString).digest('hex');
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string | number>,
  ): Promise<T> {
    const timestamp = Date.now();
    const qs = new URLSearchParams(
      Object.fromEntries([
        ...Object.entries(params).map(([k, v]) => [k, String(v)]),
        ['timestamp', String(timestamp)],
      ]),
    ).toString();

    const signature = this.sign(qs);

    const { data } = await axios.get(
      `${BINANCE_BASE_URL}${path}?${qs}&signature=${signature}`,
      {
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 15_000,
      },
    );
    return data as T;
  }
}
