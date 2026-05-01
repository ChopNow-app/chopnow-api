import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, phone: true, displayName: true, role: true, createdAt: true },
    });
    if (!user) throw new NotFoundException('user_not_found');
    return user;
  }
}
