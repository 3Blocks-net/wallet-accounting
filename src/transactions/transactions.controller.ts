// src/transactions/transactions.controller.ts
import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as csvParser from 'csv-parser';
import { ApiConsumes, ApiBody } from '@nestjs/swagger';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { TransactionsService } from './transactions.service';
import { RawRow } from './types';
import { parse } from 'csv-parse/sync';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('import')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async import(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new Error('Keine Datei hochgeladen');
    }
    const text = file.buffer.toString('utf8');
    // CSV synchron parsen
    let rows: RawRow[] = [];
    try {
      rows = parse(text, {
        columns: true, // erste Zeile = Header
        skip_empty_lines: true, // leere Zeilen überspringen
        bom: true,
      }) as RawRow[];
    } catch (err) {
      throw new Error(`Fehler beim Parsen der CSV: ${(err as Error).message}`);
    }

    return this.transactionsService.transformRawData(rows);
  }

  @Get(':txId')
  async getTransaction(@Param('txId') txId: string) {
    return this.transactionsService.findByTxId(txId);
  }

  @Get()
  async getTransactions(@Query('kind') kind?: string) {
    return this.transactionsService.findAll(kind);
  }
}
