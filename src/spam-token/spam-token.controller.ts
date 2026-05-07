import {
  Controller,
  Get,
  Param,
  Patch,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SpamTokenService, SpamStatus } from './spam-token.service';

interface ByTokenBody {
  network: string;
  asset: string;
  tokenAddress?: string | null;
  note?: string;
}

@Controller('spam-tokens')
export class SpamTokenController {
  constructor(private readonly spamTokenService: SpamTokenService) {}

  /** GET /spam-tokens?status=SPAM|WHITELISTED */
  @Get()
  findAll(@Query('status') status?: string) {
    const validStatus =
      status === 'SPAM' || status === 'WHITELISTED'
        ? (status as SpamStatus)
        : undefined;
    return this.spamTokenService.findAll(validStatus);
  }

  // ───────── by-token Routen MÜSSEN vor :id-Routen stehen ─────────
  // Sonst matched NestJS `/:id/whitelist` mit id="by-token".

  /** PATCH /spam-tokens/by-token/whitelist — Upsert mit status=WHITELISTED */
  @Patch('by-token/whitelist')
  @HttpCode(HttpStatus.OK)
  whitelistByToken(@Body() body: ByTokenBody) {
    return this.spamTokenService.setStatusByToken(
      {
        network: body.network,
        asset: body.asset,
        tokenAddress: body.tokenAddress ?? null,
      },
      'WHITELISTED',
      body.note,
    );
  }

  /** PATCH /spam-tokens/by-token/spam — Upsert mit status=SPAM */
  @Patch('by-token/spam')
  @HttpCode(HttpStatus.OK)
  markByToken(@Body() body: ByTokenBody) {
    return this.spamTokenService.setStatusByToken(
      {
        network: body.network,
        asset: body.asset,
        tokenAddress: body.tokenAddress ?? null,
      },
      'SPAM',
    );
  }

  /** GET /spam-tokens/:id */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.spamTokenService.findOne(id);
  }

  /** PATCH /spam-tokens/:id/whitelist */
  @Patch(':id/whitelist')
  @HttpCode(HttpStatus.OK)
  whitelist(
    @Param('id') id: string,
    @Body('note') note?: string,
  ) {
    return this.spamTokenService.whitelist(id, note);
  }

  /** PATCH /spam-tokens/:id/spam */
  @Patch(':id/spam')
  @HttpCode(HttpStatus.OK)
  remark(@Param('id') id: string) {
    return this.spamTokenService.remark(id);
  }
}
