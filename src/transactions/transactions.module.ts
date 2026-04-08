import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AlchemyModule } from 'src/alchemy/alchemy.module';

@Module({
  providers: [TransactionsService],
  controllers: [TransactionsController],
  imports: [PrismaModule, AlchemyModule],
  exports: [TransactionsService],
})
export class TransactionsModule {}
