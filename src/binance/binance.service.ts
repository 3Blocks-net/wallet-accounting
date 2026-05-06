import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import { RawRow } from '../transactions/types';

const BINANCE_BASE_URL = 'https://api.binance.com';

const COMPANY_START_MS = new Date('2025-05-01T00:00:00Z').getTime();

const CHUNK_MS = 89 * 24 * 60 * 60 * 1000;

const CHUNK_MS_NARROW = 24 * 60 * 60 * 1000;

const CHUNK_MS_CONVERT = 30 * 24 * 60 * 60 * 1000;

const KNOWN_QUOTES = [
  'USDT',
  'USDC',
  'BUSD',
  'FDUSD',
  'BNB',
  'BTC',
  'ETH',
  'EUR',
];

const ZERO = { usd: 0, eur: 0 };

@Injectable()
export class BinanceService {
  private readonly logger = new Logger(BinanceService.name);

  private get apiKey() {
    return process.env.BINANCE_API_KEY ?? '';
  }
  private get secretKey() {
    return process.env.BINANCE_SECRET_KEY ?? '';
  }

  async syncAll(lastSyncedAt?: Date): Promise<RawRow[]> {
    if (!this.apiKey || !this.secretKey) {
      this.logger.warn(
        'BINANCE_API_KEY / BINANCE_SECRET_KEY nicht konfiguriert — Binance-Sync übersprungen',
      );
      return [];
    }

    const startMs = lastSyncedAt ? lastSyncedAt.getTime() : COMPANY_START_MS;
    const endMs = Date.now();

    const [deposits, withdrawals, trades, fiatOrders, fiatPayments, converts] =
      await Promise.all([
        this.fetchDeposits(startMs, endMs),
        this.fetchWithdrawals(startMs, endMs),
        this.fetchTrades(startMs, endMs),
        this.fetchFiatOrders(startMs, endMs),
        this.fetchFiatPayments(startMs, endMs),
        this.fetchConvertHistory(startMs, endMs),
      ]);

    return [
      ...deposits,
      ...withdrawals,
      ...trades,
      ...fiatOrders,
      ...fiatPayments,
      ...converts,
    ];
  }

  // ─── Deposits ────────────────────────────────────────────────────────────────

  private async fetchDeposits(
    startMs: number,
    endMs: number,
  ): Promise<RawRow[]> {
    const rows: RawRow[] = [];

    for (const [start, end] of this.timeChunks(startMs, endMs)) {
      try {
        const deposits = await this.signedGet<any[]>(
          '/sapi/v1/capital/deposit/hisrec',
          { startTime: start, endTime: end, limit: 1000 },
        );

        for (const d of deposits) {
          if (d.status !== 1) continue;

          const date = new Date(d.insertTime);
          const amount = String(d.amount);

          rows.push({
            date: date.toISOString(),
            wallet_address: 'BINANCE_WALLET',
            source_type: 'TYPE_BINANCE_DEPOSIT',
            direction: 'IN',
            asset: d.coin,
            amount,
            fee: '0',
            fee_asset: '',
            price_usd: '0',
            value_usd: '0',
            price_eur: '0',
            value_eur: '0',
            network: d.network || 'BINANCE',
            from_address: 'EXTERNAL',
            to_address: d.address || 'BINANCE_WALLET',
            tx_hash: d.txId || `BINANCE_DEP:${d.insertTime}:${d.coin}`,
            token_address: '',
            operation: 'DEPOSIT',
            note: '',
          });
        }
      } catch (err) {
        this.logger.error(
          `Deposit-Fetch fehlgeschlagen [${start}-${end}]: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(`Binance Deposits: ${rows.length} Zeilen`);
    return rows;
  }

  // ─── Withdrawals ─────────────────────────────────────────────────────────────

  private async fetchWithdrawals(
    startMs: number,
    endMs: number,
  ): Promise<RawRow[]> {
    const rows: RawRow[] = [];

    for (const [start, end] of this.timeChunks(startMs, endMs)) {
      try {
        const withdrawals = await this.signedGet<any[]>(
          '/sapi/v1/capital/withdraw/history',
          { startTime: start, endTime: end, limit: 1000 },
        );

        for (const w of withdrawals) {
          if (w.status !== 6) continue;

          const amount = String(w.amount);
          const fee = String(w.transactionFee ?? '0');

          rows.push({
            date: new Date(w.applyTime).toISOString(),
            wallet_address: 'BINANCE_WALLET',
            source_type: 'TYPE_BINANCE_WITHDRAWAL',
            direction: 'OUT',
            asset: w.coin,
            amount,
            fee,
            fee_asset: w.coin,
            price_usd: '0',
            value_usd: '0',
            price_eur: '0',
            value_eur: '0',
            network: w.network || 'BINANCE',
            from_address: 'BINANCE_WALLET',
            to_address: w.address,
            tx_hash: w.txId || `BINANCE_WITH:${w.applyTime}:${w.coin}`,
            token_address: '',
            operation: 'WITHDRAWAL',
            note: '',
          });
        }
      } catch (err) {
        this.logger.error(
          `Withdrawal-Fetch fehlgeschlagen [${start}-${end}]: ${(err as Error).message}`,
        );
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
        'BINANCE_SPOT_PAIRS nicht konfiguriert — Spot-Trade-Sync übersprungen.',
      );
      return [];
    }

    const rows: RawRow[] = [];
    for (const symbol of pairs) {
      rows.push(
        ...(await this.fetchTradesForSymbol(symbol, startMs, endMs, CHUNK_MS)),
      );
    }

    this.logger.log(`Binance Trades: ${rows.length} Zeilen`);
    return rows;
  }

  private async fetchTradesForSymbol(
    symbol: string,
    startMs: number,
    endMs: number,
    chunkMs: number,
  ): Promise<RawRow[]> {
    const rows: RawRow[] = [];

    for (const [start, end] of this.timeChunks(startMs, endMs, chunkMs)) {
      try {
        const trades = await this.signedGet<any[]>('/api/v3/myTrades', {
          symbol,
          startTime: start,
          endTime: end,
          limit: 1000,
        });

        for (const trade of trades) {
          rows.push(...this.tradeToRawRows(symbol, trade));
        }
      } catch (err: any) {
        const code: number | undefined = err?.response?.data?.code;

        if (code === -1127 && chunkMs > CHUNK_MS_NARROW) {
          this.logger.warn(
            `${symbol}: max. 24h pro Request erlaubt — wechsle auf tägliche Chunks`,
          );
          return this.fetchTradesForSymbol(
            symbol,
            startMs,
            endMs,
            CHUNK_MS_NARROW,
          );
        }

        this.logger.error(
          `Trade-Fetch fehlgeschlagen für ${symbol} [${start}-${end}]: ${(err as Error).message}`,
        );
      }
    }

    return rows;
  }

  private tradeToRawRows(symbol: string, trade: any): RawRow[] {
    const parsed = this.parseSymbol(symbol);
    if (!parsed) {
      this.logger.warn(`Symbol "${symbol}" konnte nicht geparst werden`);
      return [];
    }
    const { base, quote } = parsed;

    const date = new Date(trade.time).toISOString();
    const txHash = `BINANCE_TRADE:${trade.id}`;

    const inAsset = trade.isBuyer ? base : quote;
    const outAsset = trade.isBuyer ? quote : base;
    const inAmount = trade.isBuyer ? String(trade.qty) : String(trade.quoteQty);
    const outAmount = trade.isBuyer
      ? String(trade.quoteQty)
      : String(trade.qty);

    const makeRow = (
      direction: 'IN' | 'OUT',
      asset: string,
      amount: string,
    ): RawRow => ({
      date,
      wallet_address: 'BINANCE_WALLET',
      source_type: 'TYPE_BINANCE_TRADE',
      direction,
      asset,
      amount,
      fee:
        direction === 'IN' && trade.commissionAsset === asset
          ? String(trade.commission)
          : '0',
      fee_asset:
        direction === 'IN' && trade.commissionAsset === asset ? asset : '',
      price_usd: '0',
      value_usd: '0',
      price_eur: '0',
      value_eur: '0',
      network: 'BINANCE',
      from_address: direction === 'OUT' ? 'BINANCE_WALLET' : 'BINANCE_EXCHANGE',
      to_address: direction === 'IN' ? 'BINANCE_WALLET' : 'BINANCE_EXCHANGE',
      tx_hash: txHash,
      token_address: '',
      operation: 'SPOT_TRADE',
      note: `${symbol} #${trade.id}`,
    });

    return [
      makeRow('IN', inAsset, inAmount),
      makeRow('OUT', outAsset, outAmount),
    ];
  }

  // ─── Fiat Orders ─────────────────────────────────────────────────────────────

  private async fetchFiatOrders(
    startMs: number,
    endMs: number,
  ): Promise<RawRow[]> {
    const rows: RawRow[] = [];

    for (const transactionType of [0, 1]) {
      let page = 1;
      while (true) {
        try {
          const result = await this.signedGet<{ data: any[]; total: number }>(
            '/sapi/v1/fiat/orders',
            {
              transactionType,
              beginTime: startMs,
              endTime: endMs,
              page,
              rows: 500,
            },
          );
          const orders: any[] = result?.data ?? [];

          this.logger.debug(
            `Fiat-Orders type=${transactionType} page=${page}: ${orders.length} Einträge`,
          );

          const DONE = new Set(['Successful', 'Finished']);
          for (const order of orders) {
            if (!DONE.has(order.status)) continue;

            rows.push({
              date: new Date(order.createTime).toISOString(),
              wallet_address: 'BINANCE_WALLET',
              source_type:
                transactionType === 0
                  ? 'TYPE_BINANCE_FIAT_DEPOSIT'
                  : 'TYPE_BINANCE_FIAT_WITHDRAWAL',
              direction: transactionType === 0 ? 'IN' : 'OUT',
              asset: String(order.fiatCurrency),
              amount: String(order.amount),
              fee: String(order.totalFee ?? '0'),
              fee_asset: String(order.fiatCurrency),
              price_usd: '0',
              value_usd: '0',
              price_eur: '0',
              value_eur: '0',
              network: 'BINANCE',
              from_address:
                transactionType === 0 ? '3BLOCKS_BANK' : 'BINANCE_WALLET',
              to_address:
                transactionType === 0 ? 'BINANCE_WALLET' : '3BLOCKS_BANK',
              tx_hash: `BINANCE_FIAT_ORDER:${order.orderNo}`,
              token_address: '',
              operation:
                transactionType === 0 ? 'FIAT_DEPOSIT' : 'FIAT_WITHDRAWAL',
              note: order.method || '',
            });
          }

          if (orders.length < 500) break;
          page++;
        } catch (err) {
          this.logger.error(
            `Fiat-Order-Fetch fehlgeschlagen (type=${transactionType}): ${(err as Error).message}`,
          );
          break;
        }
      }
    }

    this.logger.log(`Binance Fiat Orders: ${rows.length} Zeilen`);
    return rows;
  }

  // ─── Fiat Payments ───────────────────────────────────────────────────────────

  private async fetchFiatPayments(
    startMs: number,
    endMs: number,
  ): Promise<RawRow[]> {
    const rows: RawRow[] = [];

    for (const transactionType of [0, 1]) {
      let page = 1;
      while (true) {
        try {
          const result = await this.signedGet<{ data: any[]; total: number }>(
            '/sapi/v1/fiat/payments',
            {
              transactionType,
              beginTime: startMs,
              endTime: endMs,
              page,
              rows: 500,
            },
          );
          const payments: any[] = result?.data ?? [];

          for (const payment of payments) {
            if (payment.status !== 'Completed') continue;

            const date = new Date(payment.createTime).toISOString();
            const txHash = `BINANCE_FIAT_PAY:${payment.orderNo}`;

            const fiatAsset = String(payment.fiatCurrency);
            const cryptoAsset = String(payment.cryptoCurrency);
            const fiatAmount = String(payment.sourceAmount);
            const cryptoAmount = String(payment.obtainAmount);
            const fee = String(payment.totalFee ?? '0');

            // transactionType 0 = Kauf (Fiat raus, Krypto rein)
            const outAsset = transactionType === 0 ? fiatAsset : cryptoAsset;
            const outAmount =
              transactionType === 0 ? fiatAmount : cryptoAmount;
            const inAsset = transactionType === 0 ? cryptoAsset : fiatAsset;
            const inAmount =
              transactionType === 0 ? cryptoAmount : fiatAmount;

            const makeRow = (
              direction: 'IN' | 'OUT',
              asset: string,
              amount: string,
            ): RawRow => ({
              date,
              wallet_address: 'BINANCE_WALLET',
              source_type: 'TYPE_BINANCE_FIAT_TRADE',
              direction,
              asset,
              amount,
              fee: direction === 'IN' ? fee : '0',
              fee_asset: direction === 'IN' ? inAsset : '',
              price_usd: '0',
              value_usd: '0',
              price_eur: '0',
              value_eur: '0',
              network: 'BINANCE',
              from_address:
                direction === 'OUT' ? 'BINANCE_WALLET' : 'BINANCE_EXCHANGE',
              to_address:
                direction === 'IN' ? 'BINANCE_WALLET' : 'BINANCE_EXCHANGE',
              tx_hash: txHash,
              token_address: '',
              operation: 'FIAT_TRADE',
              note: '',
            });

            rows.push(
              makeRow('OUT', outAsset, outAmount),
              makeRow('IN', inAsset, inAmount),
            );
          }

          if (payments.length < 500) break;
          page++;
        } catch (err) {
          this.logger.error(
            `Fiat-Payment-Fetch fehlgeschlagen (type=${transactionType}): ${(err as Error).message}`,
          );
          break;
        }
      }
    }

    this.logger.log(`Binance Fiat Payments: ${rows.length} Zeilen`);
    return rows;
  }

  // ─── Convert History ─────────────────────────────────────────────────────────

  private async fetchConvertHistory(
    startMs: number,
    endMs: number,
  ): Promise<RawRow[]> {
    const rows: RawRow[] = [];

    for (const [start, end] of this.timeChunks(
      startMs,
      endMs,
      CHUNK_MS_CONVERT,
    )) {
      try {
        const result = await this.signedGet<{ list: any[] }>(
          '/sapi/v1/convert/tradeFlow',
          { startTime: start, endTime: end, limit: 1000 },
        );

        for (const order of result?.list ?? []) {
          if (order.orderStatus !== 'SUCCESS') continue;

          const date = new Date(order.createTime).toISOString();
          const txHash = `BINANCE_CONVERT:${order.orderId}`;
          const fromAsset = String(order.fromAsset);
          const toAsset = String(order.toAsset);

          rows.push(
            {
              date,
              wallet_address: 'BINANCE_WALLET',
              source_type: 'TYPE_BINANCE_CONVERT',
              direction: 'OUT',
              asset: fromAsset,
              amount: String(order.fromAmount),
              fee: '0',
              fee_asset: '',
              price_usd: '0',
              value_usd: '0',
              price_eur: '0',
              value_eur: '0',
              network: 'BINANCE',
              from_address: 'BINANCE_WALLET',
              to_address: 'BINANCE_EXCHANGE',
              tx_hash: txHash,
              token_address: '',
              operation: 'CONVERT',
              note: `${fromAsset}→${toAsset}`,
            },
            {
              date,
              wallet_address: 'BINANCE_WALLET',
              source_type: 'TYPE_BINANCE_CONVERT',
              direction: 'IN',
              asset: toAsset,
              amount: String(order.toAmount),
              fee: '0',
              fee_asset: '',
              price_usd: '0',
              value_usd: '0',
              price_eur: '0',
              value_eur: '0',
              network: 'BINANCE',
              from_address: 'BINANCE_EXCHANGE',
              to_address: 'BINANCE_WALLET',
              tx_hash: txHash,
              token_address: '',
              operation: 'CONVERT',
              note: `${fromAsset}→${toAsset}`,
            },
          );
        }
      } catch (err) {
        this.logger.error(
          `Convert-History-Fetch fehlgeschlagen [${start}-${end}]: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Binance Converts: ${rows.length / 2} Orders (${rows.length} Zeilen)`,
    );
    return rows;
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

  private *timeChunks(
    startMs: number,
    endMs: number,
    chunkMs = CHUNK_MS,
  ): Iterable<[number, number]> {
    let current = startMs;
    while (current < endMs) {
      const next = Math.min(current + chunkMs, endMs);
      yield [current, next];
      current = next + 1;
    }
  }

  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(queryString)
      .digest('hex');
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
      { headers: { 'X-MBX-APIKEY': this.apiKey }, timeout: 15_000 },
    );
    return data as T;
  }
}
