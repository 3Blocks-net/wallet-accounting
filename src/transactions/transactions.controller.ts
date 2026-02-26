// src/transactions/transactions.controller.ts
import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { type Express } from 'express'; // ← das hier fehlt
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { TransactionsService } from './transactions.service';
import * as XLSX from 'xlsx';
import * as csvParse from 'csv-parse/sync';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('import')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
        },
      },
    },
  })
  @UseInterceptors(AnyFilesInterceptor())
  async import(@UploadedFiles() files: Express.Multer.File[]) {
    // Mapping: filename → Buffer
    const fileMap = new Map<string, Express.Multer.File>();
    for (const f of files) {
      fileMap.set(f.originalname, f);
    }

    // 1) SAFE CSVs sammeln
    const safeRows: any[] = [];
    const safeCsvNames = [
      'transactions_3blocks_multisig_0x353527391365b7589503eCfFcafDFBAFf0a24D1B_1772096655931.csv',
      'transactions_pecunity_airdrop_0xfE262BcE7ba8Dc98B8e79d25bCAC88D2df8346BD_1772097421803.csv',
      'transactions_pecunity_treasury_0xd1a37EA8720EBe16B12D8acB40F419811119aBAd_1772097289600.csv',
      'transactions_pecunity_multisig_0x56B2cC86A6d1Da4Bc5567B4925dbeb8d746e5E86_1772097018035.csv',
      'transactions_pecunity_marketing_0xeabaAFACAeBfD256f07448799C79B3E80771C811_1772097481230.csv',
    ];

    for (const name of safeCsvNames) {
      const file = fileMap.get(name);
      if (!file) continue;
      const text = file.buffer.toString('utf8');
      const rows = csvParse.parse(text, {
        columns: true,
        skip_empty_lines: true,
      });
      safeRows.push(...rows);
    }

    // 2) Binance Deposit Excel
    const binanceDepositFile = fileMap.get(
      'Binance-Deposit-History-Report-2026-02-26.xlsx',
    );
    let binanceDepositRows: any[] = [];
    if (binanceDepositFile) {
      const wb = XLSX.read(binanceDepositFile.buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      binanceDepositRows = XLSX.utils.sheet_to_json(sheet);
    }

    // 3) Binance Withdraw Excel
    const binanceWithdrawFile = fileMap.get(
      'Binance-Withdraw-History-Report-2026-02-26.xlsx',
    );
    let binanceWithdrawRows: any[] = [];
    if (binanceWithdrawFile) {
      const wb = XLSX.read(binanceWithdrawFile.buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      binanceWithdrawRows = XLSX.utils.sheet_to_json(sheet);
    }

    await this.transactionsService.importAll({
      safeRows,
      binanceDepositRows,
      binanceWithdrawRows,
    });

    return { ok: true };
  }
}
