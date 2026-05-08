import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/auth.decorators';
import { TransactionsService } from './transactions.service';

@ApiTags('transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Patch(':txId')
  @Roles('ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Transaktion nachkorrigieren' })
  @ApiResponse({ status: 200, description: 'Aktualisierte Transaktion.' })
  async updateTransaction(
    @Param('txId') txId: string,
    @Body()
    body: {
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

  // Spezifische GET-Routen müssen VOR `:txId` stehen, sonst matched der
  // Param-Handler `/stats` und `/wallets` als txId.

  @Get('stats')
  @ApiOperation({
    summary: 'Aggregierte Stats: Gesamtanzahl + Counts pro Kind',
    description:
      'Liefert Total und eine Aufschlüsselung nach Kind ' +
      '(PAYMENT_IN, PAYMENT_OUT, INTERNAL, SWAP). Akzeptiert dieselben ' +
      'Filter wie GET /transactions (außer `kind` und Pagination).',
  })
  @ApiQuery({ name: 'network', required: false, type: String })
  @ApiQuery({ name: 'sourceType', required: false, type: String })
  @ApiQuery({ name: 'asset', required: false, type: String })
  @ApiQuery({ name: 'dateFrom', required: false, type: String })
  @ApiQuery({ name: 'dateTo', required: false, type: String })
  @ApiQuery({ name: 'wallet', required: false, type: String })
  @ApiQuery({ name: 'excludeSpam', required: false, type: Boolean })
  async getStats(
    @Query('network') network?: string,
    @Query('sourceType') sourceType?: string,
    @Query('asset') asset?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('wallet') wallet?: string,
    @Query('excludeSpam', new DefaultValuePipe(false), ParseBoolPipe)
    excludeSpam = false,
  ) {
    return this.transactionsService.getStats({
      network,
      sourceType,
      asset,
      dateFrom,
      dateTo,
      wallet,
      excludeSpam,
    });
  }

  @Get('wallets')
  @ApiOperation({
    summary: 'Liste aller bekannten Wallet-Namen',
    description:
      'Distinct sender + receiver aus allen Transfers — für Filter-Dropdowns.',
  })
  @ApiResponse({
    status: 200,
    description: 'Alphabetisch sortierte Wallet-Namen.',
    schema: { type: 'array', items: { type: 'string' } },
  })
  async getWallets() {
    return this.transactionsService.getWalletNames();
  }

  @Get(':txId')
  @ApiOperation({ summary: 'Einzelne Transaktion mit Transfers laden' })
  async getTransaction(@Param('txId') txId: string) {
    return this.transactionsService.findByTxId(txId);
  }

  @Get()
  @ApiOperation({
    summary: 'Transaktionen auflisten (paginiert)',
    description:
      'Liefert eine paginierte Liste von Transaktionen. Sortiert nach Datum absteigend. ' +
      'Filter und Pagination sind kombinierbar.',
  })
  @ApiQuery({
    name: 'kind',
    required: false,
    enum: ['PAYMENT_IN', 'PAYMENT_OUT', 'INTERNAL', 'SWAP'],
  })
  @ApiQuery({ name: 'network', required: false, type: String })
  @ApiQuery({ name: 'sourceType', required: false, type: String })
  @ApiQuery({ name: 'asset', required: false, type: String })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    type: String,
    description: 'ISO-Datum (YYYY-MM-DD), inklusiv',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    type: String,
    description: 'ISO-Datum (YYYY-MM-DD), inklusiv',
  })
  @ApiQuery({
    name: 'wallet',
    required: false,
    type: String,
    description:
      'Filter auf Wallet-Name — matched wenn ein Transfer der Tx als ' +
      'Sender oder Receiver diesen Namen hat.',
  })
  @ApiQuery({
    name: 'excludeSpam',
    required: false,
    type: Boolean,
    description: 'Wenn true, werden als Spam markierte Transaktionen herausgefiltert.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '1-basierte Seitenzahl (default 1)',
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    description: 'Einträge pro Seite (default 50, max 500)',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginierte Transaktionsliste.',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object' } },
        total: { type: 'integer', example: 1234 },
        page: { type: 'integer', example: 1 },
        pageSize: { type: 'integer', example: 50 },
        totalPages: { type: 'integer', example: 25 },
      },
    },
  })
  async getTransactions(
    @Query('kind') kind?: string,
    @Query('network') network?: string,
    @Query('sourceType') sourceType?: string,
    @Query('asset') asset?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('wallet') wallet?: string,
    @Query('excludeSpam', new DefaultValuePipe(false), ParseBoolPipe)
    excludeSpam = false,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('pageSize', new DefaultValuePipe(50), ParseIntPipe) pageSize = 50,
  ) {
    return this.transactionsService.findAll({
      kind,
      network,
      sourceType,
      asset,
      dateFrom,
      dateTo,
      wallet,
      excludeSpam,
      page,
      pageSize,
    });
  }
}
