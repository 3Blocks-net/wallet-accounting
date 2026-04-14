import { Controller, Get, Query } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';

@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get('balances')
  async getBalances(
    @Query('date') date: string,
    @Query('excludeSpam') excludeSpam?: string,
  ) {
    return this.portfolioService.calculateBalances(
      new Date(date),
      excludeSpam === 'true',
    );
  }
}
