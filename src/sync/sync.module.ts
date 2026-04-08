import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { AlchemyModule } from '../alchemy/alchemy.module';
import { BinanceModule } from '../binance/binance.module';
import { PriceModule } from '../price/price.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    AlchemyModule,
    BinanceModule,
    PriceModule,
    TransactionsModule,
  ],
  providers: [SyncService],
  controllers: [SyncController],
})
export class SyncModule {}
