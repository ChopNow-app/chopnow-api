import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';

const PROFILE_SELECT = {
  id: true,
  phone: true,
  email: true,
  displayName: true,
  role: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: PROFILE_SELECT,
    });
    if (!user) throw new NotFoundException('user_not_found');
    return user;
  }

  async updateProfile(id: string, dto: UpdateUserProfileDto) {
    // Empty body — refuse to silently no-op so the client knows it sent
    // nothing useful (e.g. wrong field name slipped past whitelist).
    if (Object.values(dto).every((v) => v === undefined)) {
      throw new BadRequestException('no_fields_to_update');
    }
    return this.prisma.user.update({
      where: { id },
      data: { displayName: dto.displayName },
      select: PROFILE_SELECT,
    });
  }
}
