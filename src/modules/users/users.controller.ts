import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { UsersService } from './users.service';

// JWT auth applies globally (see APP_GUARD in app.module.ts).
// Add @Public() to opt out on a specific route.
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@Req() req: Request) {
    const user = req.user as { id: string };
    return this.users.findById(user.id);
  }
}
