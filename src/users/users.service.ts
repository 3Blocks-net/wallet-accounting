import { BadRequestException, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async findAll() {
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
    return users.map((user) => this.auth.toPublicUser(user));
  }

  async create(input: { email: string; name: string; password: string; role: UserRole }) {
    if (input.password.length < 12) throw new BadRequestException('Password must be at least 12 characters');
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase().trim(),
        name: input.name.trim(),
        passwordHash,
        role: input.role,
        mustChangePassword: true,
      },
    });
    return this.auth.toPublicUser(user);
  }

  async update(
    id: string,
    input: { email?: string; name?: string; role?: UserRole; isActive?: boolean },
    actingUserId: string,
  ) {
    const current = await this.prisma.user.findUnique({ where: { id } });
    if (!current) throw new BadRequestException('User not found');

    const selfRoleDowngrade = id === actingUserId && input.role !== undefined && input.role !== 'ADMIN';
    const selfDeactivation = id === actingUserId && input.isActive === false;
    if (selfRoleDowngrade || selfDeactivation) {
      throw new BadRequestException('Admins cannot remove their own admin access');
    }

    const removesAdminAccess = current.role === 'ADMIN' && (input.role !== undefined && input.role !== 'ADMIN' || input.isActive === false);
    if (removesAdminAccess) {
      const activeAdminCount = await this.prisma.user.count({ where: { role: 'ADMIN', isActive: true } });
      if (activeAdminCount <= 1) throw new BadRequestException('At least one active admin is required');
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: {
        email: input.email ? input.email.toLowerCase().trim() : undefined,
        name: input.name?.trim(),
        role: input.role,
        isActive: input.isActive,
      },
    });
    return this.auth.toPublicUser(user);
  }

  async resetPassword(id: string, password: string) {
    if (password.length < 12) throw new BadRequestException('Password must be at least 12 characters');
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.prisma.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true },
    });
    return this.auth.toPublicUser(user);
  }
}
