import { Controller, Get, Post } from '@nestjs/common';
import { PriceFetchService } from './price-fetch.service';
import { PriceApplyService } from './price-apply.service';

@Controller('prices')
export class PriceController {
  constructor(
    private readonly fetchService: PriceFetchService,
    private readonly applyService: PriceApplyService,
  ) {}

  @Get('missing-tokens')
  getMissingTokens() {
    return this.fetchService.getMissingTokens();
  }

  @Post('fetch')
  fetchPrices() {
    return this.fetchService.fetchMissingPrices();
  }

  @Post('apply')
  applyPrices() {
    return this.applyService.applyAll();
  }

  @Post('enrich')
  async enrich() {
    const fetchResult = await this.fetchService.fetchMissingPrices();
    const applyResult = await this.applyService.applyAll();
    return { ...fetchResult, ...applyResult };
  }
}
