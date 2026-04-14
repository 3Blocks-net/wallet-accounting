import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AlchemyModule } from 'src/alchemy/alchemy.module';
import { SpamTokenModule } from 'src/spam-token/spam-token.module';

@Module({
  providers: [TransactionsService],
  controllers: [TransactionsController],
  imports: [PrismaModule, AlchemyModule, SpamTokenModule],
  exports: [TransactionsService],
})
export class TransactionsModule {}
