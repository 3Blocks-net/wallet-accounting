import { Module } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { PortfolioController } from './portfolio.controller';
import { TransactionsModule } from 'src/transactions/transactions.module';

@Module({
  controllers: [PortfolioController],
  providers: [PortfolioService],
  imports: [TransactionsModule],
})
export class PortfolioModule {}
