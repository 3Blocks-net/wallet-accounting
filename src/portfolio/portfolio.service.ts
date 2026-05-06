import { Injectable } from '@nestjs/common';
import { TransactionsService } from 'src/transactions/transactions.service';
import { isInternalAddress } from 'src/transactions/utils/wallets';

@Injectable()
export class PortfolioService {
  constructor(private readonly transactionsService: TransactionsService) {}

  async calculateBalances(targetDate: Date, excludeSpam = false) {
    type AssetEntry = { balance: number; tokenAddress: string | null };
    const balances: Record<string, Record<string, AssetEntry>> = {};

    // Alle Transaktionen bis einschließlich Ende des Zieldatums einbeziehen
    const ceiling = new Date(targetDate);
    ceiling.setUTCHours(23, 59, 59, 999);

    const transactions = await this.transactionsService.findAll({});

    for (const tx of transactions) {
      const txDate = new Date(tx.date);
      if (txDate > ceiling) continue;
      if (excludeSpam && tx.isSpam) continue;

      for (const transfer of tx.transfers) {
        if (excludeSpam && (transfer as any).isSpam) continue;

        const fromWallet = transfer.from.toLowerCase();
        const toWallet = transfer.to.toLowerCase();
        const asset = transfer.asset;
        const amount = Number(transfer.amount);
        const tokenAddress = (transfer as any).tokenAddress ?? null;

        if (fromWallet && isInternalAddress(fromWallet)) {
          balances[fromWallet] ??= {};
          const entry = balances[fromWallet][asset] ?? { balance: 0, tokenAddress };
          balances[fromWallet][asset] = { balance: entry.balance - amount, tokenAddress: entry.tokenAddress ?? tokenAddress };
        }

        if (toWallet && isInternalAddress(toWallet)) {
          balances[toWallet] ??= {};
          const entry = balances[toWallet][asset] ?? { balance: 0, tokenAddress };
          balances[toWallet][asset] = { balance: entry.balance + amount, tokenAddress: entry.tokenAddress ?? tokenAddress };
        }
      }
    }

    return balances;
  }
}
