import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: {
            otpLog: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
            user: { upsert: jest.fn() },
          },
        },
        { provide: JwtService, useValue: { signAsync: jest.fn().mockResolvedValue('token') } },
        {
          provide: EnvService,
          useValue: {
            nodeEnv: 'test',
            jwtAccessSecret: 'a'.repeat(64),
            jwtRefreshSecret: 'b'.repeat(64),
            jwtAccessTtl: '24h',
            jwtRefreshTtl: '30d',
          },
        },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });
});
