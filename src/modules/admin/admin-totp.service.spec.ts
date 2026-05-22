import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { AdminTotpService } from './admin-totp.service';
import { encryptSecret } from '../../shared/crypto/secret-envelope';

const ENVELOPE_KEY = 'test-envelope-key-do-not-reuse-1234567890';

const logger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  setContext: jest.fn(),
};

function buildPrismaMock() {
  return {
    adminTotpSecret: {
      findUnique: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    adminRecoveryCode: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn().mockImplementation(async (cb) => cb(this)),
  };
}

function build(): {
  service: AdminTotpService;
  prisma: ReturnType<typeof buildPrismaMock>;
} {
  const prisma = buildPrismaMock();
  // $transaction must pass the same shape inside the callback.
  prisma.$transaction = jest
    .fn()
    .mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
  const env = { secretEnvelopeKey: ENVELOPE_KEY } as never;
  const service = new AdminTotpService(logger as never, prisma as never, env);
  return { service, prisma };
}

describe('AdminTotpService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('isEnrolled', () => {
    it('returns false when no row exists', async () => {
      const { service, prisma } = build();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce(null);
      expect(await service.isEnrolled('u-1')).toBe(false);
    });

    it('returns false when row exists but confirmedAt is null', async () => {
      const { service, prisma } = build();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce({
        userId: 'u-1',
        confirmedAt: null,
      });
      expect(await service.isEnrolled('u-1')).toBe(false);
    });

    it('returns true when confirmedAt is set', async () => {
      const { service, prisma } = build();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce({
        userId: 'u-1',
        confirmedAt: new Date(),
      });
      expect(await service.isEnrolled('u-1')).toBe(true);
    });
  });

  describe('startEnrollment', () => {
    it('mints a secret, persists it encrypted, returns QR + cleartext', async () => {
      const { service, prisma } = build();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce(null);

      const result = await service.startEnrollment('u-1', 'admin@example.com');

      expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(result.otpauthUri).toContain('admin%40example.com');
      expect(result.otpauthUri).toContain('issuer=ChopNow%20Admin');
      expect(result.qrSvg).toContain('<svg');
      // Persisted secret must NOT equal the cleartext (envelope encryption applied).
      const stored = prisma.adminTotpSecret.upsert.mock.calls[0][0].create.secret;
      expect(stored).not.toBe(result.secret);
      expect(stored.split('.')).toHaveLength(3); // iv.tag.ct envelope shape
    });

    it('refuses to start when the user is already confirmed', async () => {
      const { service, prisma } = build();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce({
        userId: 'u-1',
        confirmedAt: new Date(),
      });
      await expect(service.startEnrollment('u-1', 'a@b')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.adminTotpSecret.upsert).not.toHaveBeenCalled();
    });

    it('allows restarting an abandoned enrollment (confirmedAt = null)', async () => {
      const { service, prisma } = build();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce({
        userId: 'u-1',
        confirmedAt: null,
      });
      await service.startEnrollment('u-1', 'a@b');
      expect(prisma.adminTotpSecret.upsert).toHaveBeenCalled();
    });
  });

  describe('confirmEnrollment', () => {
    it('verifies the first code, flips confirmedAt, mints 10 recovery codes', async () => {
      const { service, prisma } = build();
      // Use a known secret so we can produce a valid code.
      const secret = authenticator.generateSecret();
      const validCode = authenticator.generate(secret);
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce({
        userId: 'u-1',
        secret: encryptSecret(secret, ENVELOPE_KEY),
        confirmedAt: null,
      });

      const { recoveryCodes } = await service.confirmEnrollment('u-1', validCode);

      expect(recoveryCodes).toHaveLength(10);
      expect(recoveryCodes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(prisma.adminTotpSecret.update).toHaveBeenCalledWith({
        where: { userId: 'u-1' },
        data: { confirmedAt: expect.any(Date) },
      });
      // Old recovery codes wiped + 10 new ones written.
      expect(prisma.adminRecoveryCode.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u-1' },
      });
      const inserted = prisma.adminRecoveryCode.createMany.mock.calls[0][0].data as Array<{
        codeHash: string;
      }>;
      expect(inserted).toHaveLength(10);
      // Each stored value must be an argon2 hash, not the cleartext code.
      for (const row of inserted) {
        expect(row.codeHash.startsWith('$argon2')).toBe(true);
      }
    });

    it('rejects an invalid code (no enrollment side effects)', async () => {
      const { service, prisma } = build();
      const secret = authenticator.generateSecret();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce({
        userId: 'u-1',
        secret: encryptSecret(secret, ENVELOPE_KEY),
        confirmedAt: null,
      });
      await expect(service.confirmEnrollment('u-1', '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.adminTotpSecret.update).not.toHaveBeenCalled();
      expect(prisma.adminRecoveryCode.createMany).not.toHaveBeenCalled();
    });

    it('refuses to confirm a missing enrollment', async () => {
      const { service, prisma } = build();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce(null);
      await expect(service.confirmEnrollment('u-1', '123456')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('refuses to confirm twice', async () => {
      const { service, prisma } = build();
      const secret = authenticator.generateSecret();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce({
        userId: 'u-1',
        secret: encryptSecret(secret, ENVELOPE_KEY),
        confirmedAt: new Date(),
      });
      await expect(
        service.confirmEnrollment('u-1', authenticator.generate(secret)),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('verifyCode', () => {
    it('returns true for a fresh code', async () => {
      const { service, prisma } = build();
      const secret = authenticator.generateSecret();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce({
        userId: 'u-1',
        secret: encryptSecret(secret, ENVELOPE_KEY),
        confirmedAt: new Date(),
      });
      expect(await service.verifyCode('u-1', authenticator.generate(secret))).toBe(true);
    });

    it('returns false for the wrong code', async () => {
      const { service, prisma } = build();
      const secret = authenticator.generateSecret();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce({
        userId: 'u-1',
        secret: encryptSecret(secret, ENVELOPE_KEY),
        confirmedAt: new Date(),
      });
      expect(await service.verifyCode('u-1', '000000')).toBe(false);
    });

    it('returns false when no enrollment exists', async () => {
      const { service, prisma } = build();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce(null);
      expect(await service.verifyCode('u-1', '123456')).toBe(false);
    });

    it('returns false when enrollment is not yet confirmed', async () => {
      const { service, prisma } = build();
      const secret = authenticator.generateSecret();
      prisma.adminTotpSecret.findUnique.mockResolvedValueOnce({
        userId: 'u-1',
        secret: encryptSecret(secret, ENVELOPE_KEY),
        confirmedAt: null,
      });
      expect(await service.verifyCode('u-1', authenticator.generate(secret))).toBe(false);
    });
  });

  describe('consumeRecoveryCode', () => {
    it('matches one of the un-consumed codes and stamps consumedAt', async () => {
      const { service, prisma } = build();
      const raw = 'ABCD-EFGH';
      const codeHash = await argon2.hash(raw);
      prisma.adminRecoveryCode.findMany.mockResolvedValueOnce([
        { id: 'rc-1', codeHash, consumedAt: null },
      ]);

      expect(await service.consumeRecoveryCode('u-1', raw)).toBe(true);
      expect(prisma.adminRecoveryCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'rc-1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('returns false when no codes exist for the user', async () => {
      const { service, prisma } = build();
      prisma.adminRecoveryCode.findMany.mockResolvedValueOnce([]);
      expect(await service.consumeRecoveryCode('u-1', 'ABCD-EFGH')).toBe(false);
    });

    it('returns false when the code does not match any row', async () => {
      const { service, prisma } = build();
      const codeHash = await argon2.hash('REAL-CODE');
      prisma.adminRecoveryCode.findMany.mockResolvedValueOnce([
        { id: 'rc-1', codeHash, consumedAt: null },
      ]);
      expect(await service.consumeRecoveryCode('u-1', 'WRONG-CODE')).toBe(false);
      expect(prisma.adminRecoveryCode.updateMany).not.toHaveBeenCalled();
    });

    it('returns false when a concurrent consume already stamped the row', async () => {
      const { service, prisma } = build();
      const raw = 'ABCD-EFGH';
      const codeHash = await argon2.hash(raw);
      prisma.adminRecoveryCode.findMany.mockResolvedValueOnce([
        { id: 'rc-1', codeHash, consumedAt: null },
      ]);
      prisma.adminRecoveryCode.updateMany.mockResolvedValueOnce({ count: 0 });
      expect(await service.consumeRecoveryCode('u-1', raw)).toBe(false);
    });
  });
});
