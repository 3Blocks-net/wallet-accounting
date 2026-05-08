import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './auth.decorators';
import type { AuthRequest } from './auth.types';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(
    @Body() body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.login(body.email, body.password, res);
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    return this.auth.logout(res);
  }

  @Get('me')
  me(@Req() req: AuthRequest) {
    return req.user;
  }

  @Public()
  @Post('bootstrap')
  bootstrap(
    @Body() body: { email: string; name: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.bootstrapAdmin(body, res);
  }
}
