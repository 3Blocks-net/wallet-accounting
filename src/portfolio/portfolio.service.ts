import { Injectable } from '@nestjs/common';
import { TransactionsService } from 'src/transactions/transactions.service';
import { isInternalAddress } from 'src/transactions/utils/wallets';

@Injectable()
export class PortfolioService {
  constructor(private readonly transactionsService: TransactionsService) {}

  async calculateBalances(targetDate: Date) {
    const balances: Record<string, Record<string, number>> = {};

    const transactions = await this.transactionsService.findAll();

    for (const tx of transactions) {
      const txDate = new Date(tx.date);

      // nur bis Stichtag
      if (txDate > targetDate) continue;

      for (const transfer of tx.transfers) {
        const fromWallet = transfer.from.toLowerCase();
        const toWallet = transfer.to.toLowerCase();

        const asset = transfer.asset;
        const amount = Number(transfer.amount);

        if (fromWallet && isInternalAddress(fromWallet)) {
          if (!balances[fromWallet]) {
            balances[fromWallet] = {};
          }

          if (!balances[fromWallet][asset]) {
            balances[fromWallet][asset] = 0;
          }

          balances[fromWallet][asset] -= amount;
        }

        if (toWallet && isInternalAddress(toWallet)) {
          if (!balances[toWallet]) {
            balances[toWallet] = {};
          }

          if (!balances[toWallet][asset]) {
            balances[toWallet][asset] = 0;
          }

          balances[toWallet][asset] += amount;
        }
      }
    }

    return balances;
  }

  // 🔑 Wichtig: Wallet bestimmen
  private getWalletFromTransfer(transfer: any): string | null {
    // Beispiel:
    if (transfer.to === 'BINANCE_WALLET') {
      return 'BINANCE_WALLET';
    }

    if (transfer.from === 'BINANCE_WALLET') {
      return 'BINANCE_WALLET';
    }

    return null;
  }
}
