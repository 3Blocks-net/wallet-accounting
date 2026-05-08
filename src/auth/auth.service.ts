import { Injectable, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { Response } from 'express';
import { UserRole } from '@prisma/client';
import { AuthUser } from './auth.types';

interface SessionPayload {
  sub: string;
  email: string;
  role: UserRole;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get cookieName() {
    return this.config.get<string>('AUTH_COOKIE_NAME') ?? 'accounting_session';
  }

  private get jwtSecret() {
    const secret = this.config.get<string>('AUTH_COOKIE_SECRET') ?? this.config.get<string>('JWT_SECRET');
    if (!secret) throw new Error('AUTH_COOKIE_SECRET is required');
    return secret;
  }

  async validateSession(token?: string): Promise<AuthUser | null> {
    if (!token) return null;
    try {
      const payload = jwt.verify(token, this.jwtSecret) as SessionPayload;
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || !user.isActive) return null;
      return { id: user.id, email: user.email, name: user.name, role: user.role };
    } catch {
      return null;
    }
  }

  async login(email: string, password: string, res: Response) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    this.setSessionCookie(res, { sub: user.id, email: user.email, role: user.role });

    return this.toPublicUser(user);
  }

  logout(res: Response) {
    res.clearCookie(this.cookieName, this.cookieOptions());
    return { ok: true };
  }

  async bootstrapAdmin(input: { email: string; name: string; password: string }, res: Response) {
    const count = await this.prisma.user.count();
    if (count > 0) throw new ForbiddenException('Bootstrap is disabled after first user exists');
    if (input.password.length < 12) throw new BadRequestException('Password must be at least 12 characters');

    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase().trim(),
        name: input.name.trim(),
        passwordHash,
        role: 'ADMIN',
      },
    });

    this.setSessionCookie(res, { sub: user.id, email: user.email, role: user.role });
    return this.toPublicUser(user);
  }

  toPublicUser(user: { id: string; email: string; name: string; role: UserRole; isActive?: boolean; mustChangePassword?: boolean; lastLoginAt?: Date | null; createdAt?: Date; updatedAt?: Date }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private setSessionCookie(res: Response, payload: SessionPayload) {
    const token = jwt.sign(payload, this.jwtSecret, { expiresIn: '12h' });
    res.cookie(this.cookieName, token, this.cookieOptions());
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 12 * 60 * 60 * 1000,
    };
  }
}
