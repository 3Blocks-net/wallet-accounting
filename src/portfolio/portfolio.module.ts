import { Module } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { PortfolioController } from './portfolio.controller';
import { TransactionsModule } from 'src/transactions/transactions.module';
import { SpamTokenModule } from 'src/spam-token/spam-token.module';

@Module({
  controllers: [PortfolioController],
  providers: [PortfolioService],
  imports: [TransactionsModule, SpamTokenModule],
})
export class PortfolioModule {}
