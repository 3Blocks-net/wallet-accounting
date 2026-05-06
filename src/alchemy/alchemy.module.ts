import { Module } from '@nestjs/common';
import { AlchemyTransfersService } from './alchemy-transfers.service';

@Module({
  providers: [AlchemyTransfersService],
  exports: [AlchemyTransfersService],
})
export class AlchemyModule {}
