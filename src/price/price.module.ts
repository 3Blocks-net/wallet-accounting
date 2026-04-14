import { Module } from '@nestjs/common';
import { PriceService } from './price.service';
import { SpamTokenModule } from '../spam-token/spam-token.module';

@Module({
  imports: [SpamTokenModule],
  providers: [PriceService],
  exports: [PriceService],
})
export class PriceModule {}
