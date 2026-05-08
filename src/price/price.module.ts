import { Module } from '@nestjs/common';
import { PriceFetchService } from './price-fetch.service';
import { PriceApplyService } from './price-apply.service';
import { PriceController } from './price.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [PriceFetchService, PriceApplyService],
  controllers: [PriceController],
})
export class PriceModule {}
