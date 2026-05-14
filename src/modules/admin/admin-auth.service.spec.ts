import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { UserRole } from '@prisma/client';
import { AdminAuthService } from './admin-auth.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let prisma: { user: { findUnique: jest.Mock } };
  let redis: {
    get: jest.Mock;
    incrWithTTL: jest.Mock;
    del: jest.Mock;
    client: { set: jest.Mock };
  };
  let jwt: { signAsync: jest.Mock };

  const password = 'StrongPwd!2026';
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await argon2.hash(password);
  });

  beforeEach(async () => {
    prisma = { user: { findUnique: jest.fn() } };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      incrWithTTL: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(0),
      client: { set: jest.fn().mockResolvedValue('OK') },
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };

    const module = await Test.createTestingModule({
      providers: [
        AdminAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: JwtService, useValue: jwt },
        {
          provide: EnvService,
          useValue: { jwtAccessSecret: 'a'.repeat(64) },
        },
      ],
    }).compile();

    service = module.get(AdminAuthService);
  });

  it('issues an 8h access token on valid credentials', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    });

    const result = await service.login('Admin@ChopNow.App', password);

    expect(result).toEqual({
      accessToken: 'access-token',
      role: UserRole.SUPER_ADMIN,
      email: 'admin@chopnow.app',
      expiresIn: 28800,
    });
    // Signed with 8h expiry override
    const signOpts = jwt.signAsync.mock.calls[0][1];
    expect(signOpts.expiresIn).toBe('8h');
    expect(signOpts.secret).toBe('a'.repeat(64));
    // jti present so concurrent logins are distinguishable in audit logs
    expect(signOpts.jwtid).toMatch(/^[0-9a-f-]{36}$/);
    // Counter reset on success — guards against locking a returning admin
    // who got it wrong once an hour ago
    expect(redis.del).toHaveBeenCalledWith('admin:login-attempts:admin-1');
  });

  it('rejects with invalid_credentials for an unknown email (no enumeration)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.login('nope@example.com', password)).rejects.toMatchObject({
      response: { code: 'invalid_credentials' },
    });
  });

  it('rejects with invalid_credentials when the user is not an admin role', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'consumer@example.com',
      passwordHash,
      role: UserRole.CONSUMER,
    });

    await expect(service.login('consumer@example.com', password)).rejects.toMatchObject({
      response: { code: 'invalid_credentials' },
    });
  });

  it('rejects with invalid_credentials when the user has no passwordHash', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash: null,
      role: UserRole.SUPER_ADMIN,
    });

    await expect(service.login('admin@chopnow.app', password)).rejects.toMatchObject({
      response: { code: 'invalid_credentials' },
    });
  });

  it('rejects with account_locked when the lock key is set', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    });
    redis.get.mockResolvedValue('1');

    await expect(service.login('admin@chopnow.app', password)).rejects.toMatchObject({
      response: { code: 'account_locked' },
    });
    // Never even runs argon2 — short-circuit before any expensive crypto
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('increments the counter on a wrong password and surfaces invalid_credentials', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    });
    redis.incrWithTTL.mockResolvedValue(2);

    await expect(service.login('admin@chopnow.app', 'WrongPwd!2026')).rejects.toMatchObject({
      response: { code: 'invalid_credentials' },
    });
    expect(redis.incrWithTTL).toHaveBeenCalledWith('admin:login-attempts:admin-1', 15 * 60);
    // Below the threshold — no lock yet
    expect(redis.client.set).not.toHaveBeenCalled();
  });

  it('locks the account on the 5th failed attempt (threshold = 5)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    });
    redis.incrWithTTL.mockResolvedValue(5);

    await expect(service.login('admin@chopnow.app', 'WrongPwd!2026')).rejects.toMatchObject({
      response: { code: 'account_locked' },
    });
    // Lock key set with no TTL — only manual unlock clears it
    expect(redis.client.set).toHaveBeenCalledWith('admin:locked:admin-1', '1');
  });

  it('unlock() clears both keys', async () => {
    await service.unlock('admin-1');
    expect(redis.del).toHaveBeenCalledWith('admin:locked:admin-1', 'admin:login-attempts:admin-1');
  });

  it('normalises the email (lowercase + trim) before lookup', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.login('  Admin@ChopNow.App  ', password)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'admin@chopnow.app' },
    });
  });
});
