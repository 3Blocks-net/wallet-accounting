import { Module } from '@nestjs/common';
import { SpamTokenService } from './spam-token.service';
import { SpamTokenController } from './spam-token.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [SpamTokenService],
  controllers: [SpamTokenController],
  exports: [SpamTokenService],
})
export class SpamTokenModule {}
