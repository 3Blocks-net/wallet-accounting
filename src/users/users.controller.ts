import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.types';
import { UsersService } from './users.service';

@Roles('ADMIN')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  findAll() {
    return this.users.findAll();
  }

  @Post()
  create(@Body() body: { email: string; name: string; password: string; role: UserRole }) {
    return this.users.create(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { email?: string; name?: string; role?: UserRole; isActive?: boolean },
    @Req() req: AuthRequest,
  ) {
    return this.users.update(id, body, req.user!.id);
  }

  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @Body() body: { password: string }) {
    return this.users.resetPassword(id, body.password);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.users.update(id, { isActive: false }, req.user!.id);
  }

  @Post(':id/reactivate')
  reactivate(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.users.update(id, { isActive: true }, req.user!.id);
  }
}
