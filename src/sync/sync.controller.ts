import { Controller, Post } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /** Manueller Sync-Trigger (z.B. für initiale Daten-Befüllung) */
  @Post('trigger')
  @Roles('ADMIN')
  async trigger() {
    return this.syncService.sync();
  }
}
