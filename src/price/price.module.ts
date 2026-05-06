import { Module } from '@nestjs/common';
import { PriceService } from './price.service';
import { PriceEnrichmentService } from './price-enrichment.service';
import { PriceController } from './price.controller';
import { SpamTokenModule } from '../spam-token/spam-token.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule, SpamTokenModule],
  providers: [PriceService, PriceEnrichmentService],
  controllers: [PriceController],
  exports: [PriceService, PriceEnrichmentService],
})
export class PriceModule {}
