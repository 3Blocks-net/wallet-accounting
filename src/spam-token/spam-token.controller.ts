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
