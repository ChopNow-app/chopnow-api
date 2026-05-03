import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { OtpStatus, UserRole } from '@prisma/client';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OtpDeliveryService } from '../../infra/twilio/otp-delivery.service';

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 3;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly env: EnvService,
    private readonly otpDelivery: OtpDeliveryService,
  ) {}

  /**
   * Story 1.1 — request an OTP.
   * 1) generate 6-digit code, hash with argon2id, persist OtpLog row with channel=WHATSAPP/PENDING
   * 2) attempt delivery (WhatsApp → SMS fallback)
   * 3) update the row with the channel actually used + DELIVERED status
   */
  async requestOtp(phone: string): Promise<{ ok: true; expiresInSeconds: number }> {
    const code = this.generateCode();
    const codeHash = await argon2.hash(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    const log = await this.prisma.otpLog.create({
      data: { phone, channel: 'WHATSAPP', status: 'PENDING', codeHash, expiresAt },
    });

    try {
      const { channel } = await this.otpDelivery.sendOtp(phone, code);
      await this.prisma.otpLog.update({
        where: { id: log.id },
        data: { channel, status: OtpStatus.DELIVERED, deliveredAt: new Date() },
      });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(`OTP delivery failed for ${phone}: ${reason}`);
      await this.prisma.otpLog.update({
        where: { id: log.id },
        data: { status: OtpStatus.FAILED, failedReason: reason },
      });
      // Surface a generic error — don't leak provider internals to the client.
      throw new UnauthorizedException('otp_delivery_failed');
    }

    return { ok: true, expiresInSeconds: OTP_TTL_MINUTES * 60 };
  }

  async verifyOtp(
    phone: string,
    code: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const log = await this.prisma.otpLog.findFirst({
      where: { phone, status: { in: ['PENDING', 'DELIVERED'] }, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!log) throw new UnauthorizedException('otp_invalid_or_expired');

    if (log.attempts >= OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('otp_too_many_attempts');
    }

    const valid = await argon2.verify(log.codeHash, code);
    if (!valid) {
      await this.prisma.otpLog.update({
        where: { id: log.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('otp_invalid_or_expired');
    }

    await this.prisma.otpLog.update({
      where: { id: log.id },
      data: { status: OtpStatus.VERIFIED, verifiedAt: new Date() },
    });

    const user = await this.prisma.user.upsert({
      where: { phone },
      update: {},
      create: { phone, role: UserRole.CONSUMER },
    });

    return this.signTokens(user.id, user.role);
  }

  private async signTokens(userId: string, role: UserRole) {
    const accessTtl = this.env.jwtAccessTtl as `${number}${'s' | 'm' | 'h' | 'd'}`;
    const refreshTtl = this.env.jwtRefreshTtl as `${number}${'s' | 'm' | 'h' | 'd'}`;
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { sub: userId, role },
        { secret: this.env.jwtAccessSecret, expiresIn: accessTtl },
      ),
      this.jwt.signAsync(
        { sub: userId, role },
        { secret: this.env.jwtRefreshSecret, expiresIn: refreshTtl },
      ),
    ]);
    return { accessToken, refreshToken };
  }

  private generateCode(): string {
    if (this.env.nodeEnv === 'test') return '000000';
    const n = Math.floor(Math.random() * 1_000_000);
    return n.toString().padStart(6, '0');
  }
}
