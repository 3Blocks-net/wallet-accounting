import { Controller, Post } from '@nestjs/common';
import { PriceEnrichmentService } from './price-enrichment.service';

@Controller('prices')
export class PriceController {
  constructor(private readonly enrichmentService: PriceEnrichmentService) {}

  @Post('enrich')
  async enrich() {
    return this.enrichmentService.enrichAll();
  }
}
