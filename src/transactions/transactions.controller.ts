import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { TransactionsService } from './transactions.service';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Patch(':txId')
  async updateTransaction(
    @Param('txId') txId: string,
    @Body() body: {
      kind?: string;
      note?: string;
      isSpam?: boolean;
      feeAsset?: string;
      feeAmount?: string;
      feePayerAddress?: string;
      feePayer?: string;
      priceUsd?: string;
      valueUsd?: string;
      priceEur?: string;
      valueEur?: string;
    },
  ) {
    return this.transactionsService.updateTransaction(txId, body);
  }

  @Get(':txId')
  async getTransaction(@Param('txId') txId: string) {
    return this.transactionsService.findByTxId(txId);
  }

  @Get()
  async getTransactions(
    @Query('kind') kind?: string,
    @Query('network') network?: string,
    @Query('sourceType') sourceType?: string,
    @Query('asset') asset?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.transactionsService.findAll({
      kind,
      network,
      sourceType,
      asset,
      dateFrom,
      dateTo,
    });
  }
}
