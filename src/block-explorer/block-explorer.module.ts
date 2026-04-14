import { Module } from '@nestjs/common';
import { BlockExplorerService } from './block-explorer.service';

@Module({
  providers: [BlockExplorerService],
  exports: [BlockExplorerService],
})
export class BlockExplorerModule {}
