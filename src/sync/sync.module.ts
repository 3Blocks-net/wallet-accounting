import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { MoralisModule } from '../moralis/moralis.module';
import { BinanceModule } from '../binance/binance.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AlchemyModule } from '../alchemy/alchemy.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    MoralisModule,
    BinanceModule,
    TransactionsModule,
    AlchemyModule,
  ],
  providers: [SyncService],
  controllers: [SyncController],
})
export class SyncModule {}
