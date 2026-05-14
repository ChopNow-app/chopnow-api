import { Test } from '@nestjs/testing';
import { JwtRevocationService } from './jwt-revocation.service';
import { RedisService } from '../../infra/redis/redis.service';
import { EnvService } from '../../infra/config/env.service';

describe('JwtRevocationService', () => {
  let service: JwtRevocationService;
  let redis: { get: jest.Mock; del: jest.Mock; setWithTTL: jest.Mock };

  beforeEach(async () => {
    redis = {
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      setWithTTL: jest.fn().mockResolvedValue('OK'),
    };
    const module = await Test.createTestingModule({
      providers: [
        JwtRevocationService,
        { provide: RedisService, useValue: redis },
        { provide: EnvService, useValue: { jwtRefreshTtl: '30d' } },
      ],
    }).compile();
    service = module.get(JwtRevocationService);
  });

  it('revokeUser sets the Redis key with TTL = refresh TTL', async () => {
    await service.revokeUser('user-1');
    expect(redis.setWithTTL).toHaveBeenCalledWith(
      'user:revoked:user-1',
      '1',
      30 * 24 * 3600, // 30d in seconds
    );
  });

  it('reactivateUser deletes the Redis key', async () => {
    await service.reactivateUser('user-1');
    expect(redis.del).toHaveBeenCalledWith('user:revoked:user-1');
  });

  it('isRevoked returns true when the key exists', async () => {
    redis.get.mockResolvedValue('1');
    await expect(service.isRevoked('user-1')).resolves.toBe(true);
  });

  it('isRevoked returns false when the key is absent', async () => {
    redis.get.mockResolvedValue(null);
    await expect(service.isRevoked('user-1')).resolves.toBe(false);
  });

  it.each([
    ['15m', 15 * 60],
    ['24h', 24 * 3600],
    ['7d', 7 * 24 * 3600],
    ['90d', 90 * 24 * 3600],
  ])('TTL aligns with JWT_REFRESH_TTL=%s (= %i seconds)', async (refreshTtl, expectedSeconds) => {
    const module = await Test.createTestingModule({
      providers: [
        JwtRevocationService,
        { provide: RedisService, useValue: redis },
        { provide: EnvService, useValue: { jwtRefreshTtl: refreshTtl } },
      ],
    }).compile();
    const localService = module.get(JwtRevocationService);

    await localService.revokeUser('user-1');

    expect(redis.setWithTTL).toHaveBeenLastCalledWith('user:revoked:user-1', '1', expectedSeconds);
  });
});
