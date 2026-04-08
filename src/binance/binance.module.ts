import { Module } from '@nestjs/common';
import { BinanceService } from './binance.service';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [PriceModule],
  providers: [BinanceService],
  exports: [BinanceService],
})
export class BinanceModule {}
