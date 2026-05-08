import { Controller, Post } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { PriceEnrichmentService } from './price-enrichment.service';

@Controller('prices')
export class PriceController {
  constructor(private readonly enrichmentService: PriceEnrichmentService) {}

  @Post('enrich')
  @Roles('ADMIN')
  async enrich() {
    return this.enrichmentService.enrichAll();
  }
}
