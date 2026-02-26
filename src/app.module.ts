import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { TransactionsModule } from './transactions/transactions.module';
import { ConfigModule } from '@nestjs/config';
import { AlchemyModule } from './alchemy/alchemy.module';

@Module({
  imports: [
    PrismaModule,

    TransactionsModule,
    ConfigModule.forRoot({ isGlobal: true }),
    AlchemyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
