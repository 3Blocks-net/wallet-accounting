import { Controller, Post, Get } from '@nestjs/common';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /** Manueller Sync-Trigger (z.B. für initiale Daten-Befüllung) */
  @Post('trigger')
  async trigger() {
    return this.syncService.sync();
  }
}
