import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import { UsersService } from './users.service';

// JWT auth applies globally (see APP_GUARD in app.module.ts).
// Add @Public() to opt out on a specific route.
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Current authenticated user profile' })
  me(@Req() req: Request) {
    const user = req.user as { id: string };
    return this.users.findById(user.id);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Update own profile (Story 1.8)',
    description:
      'Self-update for any authenticated user. Today: displayName only. ' +
      'Vendor-specific fields → PATCH /vendors/me; rider-specific → PATCH /riders/me. ' +
      'MoMo number change with OTP-on-new-number confirmation is deferred — admin oversight covers MVP.',
  })
  updateMe(@Req() req: Request, @Body() dto: UpdateUserProfileDto) {
    const user = req.user as { id: string };
    return this.users.updateProfile(user.id, dto);
  }
}
