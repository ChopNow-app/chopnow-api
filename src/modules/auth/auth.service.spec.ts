import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { OtpStatus } from '@prisma/client';
import { AuthService } from './auth.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OtpDeliveryService } from '../../infra/twilio/otp-delivery.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    otpLog: {
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    user: { upsert: jest.Mock };
  };
  let otpDelivery: { sendOtp: jest.Mock };

  beforeEach(async () => {
    prisma = {
      otpLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', role: 'CONSUMER' }) },
    };
    otpDelivery = {
      sendOtp: jest.fn().mockResolvedValue({ channel: 'WHATSAPP', providerMessageId: 'SMxxx' }),
    };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
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
        { provide: OtpDeliveryService, useValue: otpDelivery },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('requestOtp', () => {
    it('normalizes a Cameroon-local phone before persisting', async () => {
      await service.requestOtp('670000000');

      // Both the create (initial PENDING) and the post-send update
      // should reference the canonical +237 form, not the bare 9-digit input.
      const created = prisma.otpLog.create.mock.calls[0][0].data;
      expect(created.phone).toBe('+237670000000');
      expect(otpDelivery.sendOtp).toHaveBeenCalledWith('+237670000000', expect.any(String));
    });

    it('passes through E.164 international numbers unchanged', async () => {
      await service.requestOtp('+33695412820');

      const created = prisma.otpLog.create.mock.calls[0][0].data;
      expect(created.phone).toBe('+33695412820');
      expect(otpDelivery.sendOtp).toHaveBeenCalledWith('+33695412820', expect.any(String));
    });

    it('stores SENT (not DELIVERED) and the provider SID after a successful send', async () => {
      // The optimistic DELIVERED bug: messages.create() returning a SID does not
      // mean the message was delivered — it might still fail downstream. The
      // status webhook reconciles to DELIVERED/FAILED later.
      await service.requestOtp('670000000');

      const updateArgs = prisma.otpLog.update.mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: 'log-1' });
      expect(updateArgs.data).toMatchObject({
        status: OtpStatus.SENT,
        providerMessageId: 'SMxxx',
        channel: 'WHATSAPP',
      });
      expect(updateArgs.data.deliveredAt).toBeUndefined();
    });

    it('marks the row FAILED when delivery throws and surfaces a generic error', async () => {
      otpDelivery.sendOtp.mockRejectedValueOnce(new Error('Authentication Error'));

      await expect(service.requestOtp('670000000')).rejects.toThrow(UnauthorizedException);

      const updateArgs = prisma.otpLog.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe(OtpStatus.FAILED);
      expect(updateArgs.data.failedReason).toBe('Authentication Error');
    });
  });

  describe('verifyOtp', () => {
    it('looks up the OtpLog using the canonical phone form', async () => {
      prisma.otpLog.findFirst.mockResolvedValue(null);

      await expect(service.verifyOtp('670000000', '123456')).rejects.toThrow(UnauthorizedException);

      const where = prisma.otpLog.findFirst.mock.calls[0][0].where;
      expect(where.phone).toBe('+237670000000');
    });

    it('accepts rows in SENT state (post-send, pre-webhook reconciliation)', async () => {
      // Real-world race: user receives WhatsApp + types code before Twilio's
      // delivery callback fires. Row is still SENT in DB. Verify must work.
      const code = '123456';
      const codeHash = await argon2.hash(code);
      prisma.otpLog.findFirst.mockResolvedValue({
        id: 'log-1',
        codeHash,
        attempts: 0,
        status: OtpStatus.SENT,
      });

      const result = await service.verifyOtp('+237670000000', code);

      expect(result).toEqual({ accessToken: 'token', refreshToken: 'token' });
      const statusFilter = prisma.otpLog.findFirst.mock.calls[0][0].where.status;
      expect(statusFilter.in).toEqual(
        expect.arrayContaining([OtpStatus.PENDING, OtpStatus.SENT, OtpStatus.DELIVERED]),
      );
    });
  });
});
