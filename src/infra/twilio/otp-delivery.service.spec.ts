import { OtpStatus } from '@prisma/client';
import { OtpDeliveryService } from './otp-delivery.service';

describe('OtpDeliveryService.handleTwilioStatus', () => {
  let service: OtpDeliveryService;
  let prisma: { otpLog: { findUnique: jest.Mock; update: jest.Mock } };

  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    setContext: jest.fn(),
  };

  beforeEach(() => {
    prisma = {
      otpLog: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const twilio = {} as never;
    const env = {} as never;
    service = new OtpDeliveryService(logger as never, twilio, env, prisma as never);
  });

  it('flips a SENT row to DELIVERED on MessageStatus=delivered', async () => {
    prisma.otpLog.findUnique.mockResolvedValue({
      id: 'log-1',
      status: OtpStatus.SENT,
    });

    await service.handleTwilioStatus('SMxxx', 'delivered');

    const upd = prisma.otpLog.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'log-1' });
    expect(upd.data.status).toBe(OtpStatus.DELIVERED);
    expect(upd.data.deliveredAt).toBeInstanceOf(Date);
  });

  it('treats "read" (WhatsApp blue ticks) like delivered', async () => {
    prisma.otpLog.findUnique.mockResolvedValue({ id: 'log-1', status: OtpStatus.SENT });
    await service.handleTwilioStatus('SMxxx', 'read');
    expect(prisma.otpLog.update.mock.calls[0][0].data.status).toBe(OtpStatus.DELIVERED);
  });

  it('marks FAILED with the explicit ErrorMessage when present', async () => {
    prisma.otpLog.findUnique.mockResolvedValue({ id: 'log-1', status: OtpStatus.SENT });
    await service.handleTwilioStatus('SMxxx', 'failed', 'Channel could not deliver', '63015');
    const upd = prisma.otpLog.update.mock.calls[0][0];
    expect(upd.data.status).toBe(OtpStatus.FAILED);
    expect(upd.data.failedReason).toBe('Channel could not deliver');
  });

  it('falls back to twilio_error_<code> when ErrorMessage is missing', async () => {
    prisma.otpLog.findUnique.mockResolvedValue({ id: 'log-1', status: OtpStatus.SENT });
    await service.handleTwilioStatus('SMxxx', 'undelivered', undefined, '30008');
    expect(prisma.otpLog.update.mock.calls[0][0].data.failedReason).toBe('twilio_error_30008');
  });

  it('falls back to twilio_error_unknown when neither message nor code is present', async () => {
    prisma.otpLog.findUnique.mockResolvedValue({ id: 'log-1', status: OtpStatus.SENT });
    await service.handleTwilioStatus('SMxxx', 'failed');
    expect(prisma.otpLog.update.mock.calls[0][0].data.failedReason).toBe('twilio_error_unknown');
  });

  it('no-ops on intermediate statuses (queued / sent / sending)', async () => {
    prisma.otpLog.findUnique.mockResolvedValue({ id: 'log-1', status: OtpStatus.SENT });
    await service.handleTwilioStatus('SMxxx', 'queued');
    await service.handleTwilioStatus('SMxxx', 'sent');
    await service.handleTwilioStatus('SMxxx', 'sending');
    expect(prisma.otpLog.update).not.toHaveBeenCalled();
  });

  it('drops silently when the SID is unknown (non-OTP message)', async () => {
    prisma.otpLog.findUnique.mockResolvedValue(null);
    await service.handleTwilioStatus('SM-not-ours', 'delivered');
    expect(prisma.otpLog.update).not.toHaveBeenCalled();
  });

  it('does not downgrade a row already VERIFIED (late callback race)', async () => {
    // User typed the OTP and verifyOtp won; Twilio's late "failed" callback
    // arrives. Must not flip VERIFIED back to FAILED.
    prisma.otpLog.findUnique.mockResolvedValue({ id: 'log-1', status: OtpStatus.VERIFIED });
    await service.handleTwilioStatus('SMxxx', 'failed', 'Channel could not deliver');
    expect(prisma.otpLog.update).not.toHaveBeenCalled();
  });

  it('does not re-write a row already FAILED (terminal-state idempotency)', async () => {
    prisma.otpLog.findUnique.mockResolvedValue({ id: 'log-1', status: OtpStatus.FAILED });
    await service.handleTwilioStatus('SMxxx', 'delivered');
    expect(prisma.otpLog.update).not.toHaveBeenCalled();
  });
});
