import { randomBytes } from 'node:crypto';
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../../shared/crypto/secret-envelope';

/**
 * RFC 6238 TOTP for admin login (Phase A1). Wraps `otplib` so the rest of
 * the codebase doesn't import a 3rd-party verifier directly.
 *
 * Storage:
 *   - secret: AES-256-GCM with APP_SECRET_ENVELOPE_KEY at rest. We need
 *     cleartext at verify time (otplib computes the expected code from the
 *     shared secret), so argon2 hashing isn't usable here.
 *   - recovery codes: 10 mints per enrollment, argon2id-hashed, single-use.
 *
 * Verification window: otplib default is ±1 step (one 30s slot before/after)
 * to absorb minor clock drift between server and client. Higher windows
 * weaken the security; lower windows reject legitimate codes the user typed
 * within a second of the slot boundary. ±1 is the industry standard.
 */

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 5; // 5 bytes → 8 chars base32 → 40 bits entropy each

@Injectable()
export class AdminTotpService {
  constructor(
    @InjectPinoLogger(AdminTotpService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {
    // Default ±1 step (30s before, 30s after, plus current). Configurable
    // upward if user reports recur — never lower.
    authenticator.options = { window: 1 };
  }

  /**
   * Whether this admin has completed TOTP enrollment. Used by the login
   * controller to decide between issuing an immediate access token and
   * stepping into a 2fa challenge.
   */
  async isEnrolled(userId: string): Promise<boolean> {
    const row = await this.prisma.adminTotpSecret.findUnique({ where: { userId } });
    return Boolean(row?.confirmedAt);
  }

  /**
   * Step 1 of enrollment: mint a fresh secret, store it (unconfirmed),
   * return the QR + cleartext for the admin's authenticator app. If a
   * confirmedAt already exists, refuse — re-enrollment requires going
   * through disable-2fa first (super-admin only, separate endpoint).
   */
  async startEnrollment(
    userId: string,
    email: string,
  ): Promise<{ otpauthUri: string; qrSvg: string; secret: string }> {
    const existing = await this.prisma.adminTotpSecret.findUnique({ where: { userId } });
    if (existing?.confirmedAt) {
      throw new ConflictException({
        code: 'totp_already_enrolled',
        message: 'TOTP is already enrolled for this account. Disable it first to re-enroll.',
      });
    }

    const secret = authenticator.generateSecret(20); // 20 bytes → 32 chars base32
    const otpauthUri = authenticator.keyuri(email, 'ChopNow Admin', secret);
    const qrSvg = await QRCode.toString(otpauthUri, { type: 'svg', errorCorrectionLevel: 'M' });

    const encrypted = encryptSecret(secret, this.env.secretEnvelopeKey);
    await this.prisma.adminTotpSecret.upsert({
      where: { userId },
      update: { secret: encrypted, confirmedAt: null }, // re-mint for an abandoned enrollment
      create: { userId, secret: encrypted },
    });

    return { otpauthUri, qrSvg, secret };
  }

  /**
   * Step 2 of enrollment: the admin scanned the QR and submits a current
   * code. Mark enrollment confirmed + mint + return recovery codes (shown
   * ONCE; they're argon2-hashed before storage, so we can't recover them).
   */
  async confirmEnrollment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const row = await this.prisma.adminTotpSecret.findUnique({ where: { userId } });
    if (!row) {
      throw new ConflictException({
        code: 'totp_enrollment_not_started',
        message: 'No TOTP enrollment in progress. Start one first.',
      });
    }
    if (row.confirmedAt) {
      throw new ConflictException({
        code: 'totp_already_enrolled',
        message: 'TOTP is already confirmed for this account.',
      });
    }

    const secret = decryptSecret(row.secret, this.env.secretEnvelopeKey);
    if (!authenticator.check(code, secret)) {
      throw new UnauthorizedException({
        code: 'totp_invalid_code',
        message: 'The code is incorrect or expired. Try the next one your app shows.',
      });
    }

    const cleartextCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
    const hashed = await Promise.all(cleartextCodes.map((c) => argon2.hash(c)));

    await this.prisma.$transaction(async (tx) => {
      await tx.adminTotpSecret.update({
        where: { userId },
        data: { confirmedAt: new Date() },
      });
      // Replace any prior recovery codes — the admin only ever has one
      // active set tied to their current enrollment.
      await tx.adminRecoveryCode.deleteMany({ where: { userId } });
      await tx.adminRecoveryCode.createMany({
        data: hashed.map((codeHash) => ({ userId, codeHash })),
      });
    });

    this.logger.info(
      { event: 'admin_totp_enrolled', userId },
      'Admin TOTP enrolled — recovery codes minted',
    );
    return { recoveryCodes: cleartextCodes };
  }

  /**
   * Verify a TOTP code in the login flow (after step-1 password check).
   * Returns true on success, false otherwise — caller throws.
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const row = await this.prisma.adminTotpSecret.findUnique({ where: { userId } });
    if (!row?.confirmedAt) return false;
    const secret = decryptSecret(row.secret, this.env.secretEnvelopeKey);
    return authenticator.check(code, secret);
  }

  /**
   * Single-use recovery code redemption. Iterates the user's un-consumed
   * codes (argon2-hashed at rest), argon2.verify on each, stamps consumedAt
   * on the matching row inside a transaction so two concurrent uses can't
   * both succeed.
   */
  async consumeRecoveryCode(userId: string, rawCode: string): Promise<boolean> {
    const candidates = await this.prisma.adminRecoveryCode.findMany({
      where: { userId, consumedAt: null },
    });
    if (candidates.length === 0) return false;

    for (const row of candidates) {
      if (await argon2.verify(row.codeHash, rawCode)) {
        // Status-guarded consume — defends against double-consume races.
        const res = await this.prisma.adminRecoveryCode.updateMany({
          where: { id: row.id, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        if (res.count === 1) {
          this.logger.warn(
            { event: 'admin_totp_recovery_used', userId, remaining: candidates.length - 1 },
            'Admin used a TOTP recovery code',
          );
          return true;
        }
        return false; // someone else consumed this exact row at the same instant
      }
    }
    return false;
  }
}

/**
 * Generate `count` 10-char alphanumeric recovery codes. Crypto-random so
 * an attacker can't predict them from a partial leak.
 * Format: `XXXX-YYYY` — two 4-char groups for typing ergonomics.
 */
function generateRecoveryCodes(count: number): string[] {
  // Crockford base32-ish (no ambiguous characters) to match the OTP code
  // alphabet — easier to read off paper / phone.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(RECOVERY_CODE_BYTES);
    let raw = '';
    for (let j = 0; j < bytes.length; j++) {
      raw += alphabet[bytes[j] % alphabet.length];
    }
    // Append one more char so total = RECOVERY_CODE_BYTES + 1 = 6 base32 chars → 30 bits ≈ ~1 billion
    // …actually with 8 chars we get 40 bits. Let's mint 8 chars directly.
    const extraBytes = randomBytes(3);
    for (let j = 0; j < extraBytes.length; j++) {
      raw += alphabet[extraBytes[j] % alphabet.length];
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}
