import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
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
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) => (k === 'NODE_ENV' ? 'test' : undefined)),
            getOrThrow: jest.fn(() => 'a'.repeat(64)),
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
