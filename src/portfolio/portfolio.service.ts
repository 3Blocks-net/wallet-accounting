import { Injectable } from '@nestjs/common';
import { TransactionsService } from 'src/transactions/transactions.service';
import { SpamTokenService } from 'src/spam-token/spam-token.service';
import { isInternalAddress } from 'src/transactions/utils/wallets';

@Injectable()
export class PortfolioService {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly spamTokenService: SpamTokenService,
  ) {}

  async calculateBalances(targetDate: Date, excludeSpam = false) {
    const balances: Record<string, Record<string, number>> = {};

    const [transactions, spamSymbols] = await Promise.all([
      this.transactionsService.findAll(),
      excludeSpam ? this.spamTokenService.getSpamSymbols() : Promise.resolve(new Set<string>()),
    ]);

    for (const tx of transactions) {
      const txDate = new Date(tx.date);
      if (txDate > targetDate) continue;

      for (const transfer of tx.transfers) {
        if (excludeSpam && spamSymbols.has(transfer.asset?.toUpperCase() ?? '')) continue;

        const fromWallet = transfer.from.toLowerCase();
        const toWallet = transfer.to.toLowerCase();
        const asset = transfer.asset;
        const amount = Number(transfer.amount);

        if (fromWallet && isInternalAddress(fromWallet)) {
          balances[fromWallet] ??= {};
          balances[fromWallet][asset] = (balances[fromWallet][asset] ?? 0) - amount;
        }

        if (toWallet && isInternalAddress(toWallet)) {
          balances[toWallet] ??= {};
          balances[toWallet][asset] = (balances[toWallet][asset] ?? 0) + amount;
        }
      }
    }

    return balances;
  }
}
