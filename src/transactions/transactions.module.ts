import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { SpamTokenModule } from 'src/spam-token/spam-token.module';

@Module({
  providers: [TransactionsService],
  controllers: [TransactionsController],
  imports: [PrismaModule, SpamTokenModule],
  exports: [TransactionsService],
})
export class TransactionsModule {}
