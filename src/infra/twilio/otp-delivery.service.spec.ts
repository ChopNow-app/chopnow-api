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

describe('OtpDeliveryService.sendOtp — bypass paths', () => {
  // Real Twilio creds shape (passes isTwilioConfigured) so we exercise the
  // bypass logic, not the no-credentials short-circuit.
  const TWILIO_OK = {
    // Must NOT contain "xxxx" (isTwilioConfigured rejects placeholder
    // SIDs from .env.example). Use a plausible-looking digit suffix.
    sid: 'AC' + '0123456789abcdef0123456789abcdef',
    authToken: 'real_token',
    whatsappFrom: 'whatsapp:+14155238886',
    smsFrom: '+1234567890',
    statusCallbackUrl: 'https://api-staging.tchopnow.app/api/twilio/status',
  };

  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    setContext: jest.fn(),
  };

  let twilio: { sendWhatsApp: jest.Mock; sendSms: jest.Mock };
  let env: { twilio: typeof TWILIO_OK };
  let prisma: object;
  let service: OtpDeliveryService;
  const origEnv = { ...process.env };

  beforeEach(() => {
    twilio = {
      sendWhatsApp: jest.fn().mockResolvedValue('SMreal'),
      sendSms: jest.fn().mockResolvedValue('SMsmsreal'),
    };
    env = { twilio: TWILIO_OK };
    prisma = {};
    service = new OtpDeliveryService(
      logger as never,
      twilio as never,
      env as never,
      prisma as never,
    );
    // Clean the bypass env between tests so prior cases don't leak.
    delete process.env.OTP_DEV_BYPASS;
    delete process.env.OTP_BYPASS_PHONES;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('routes through Twilio when neither bypass var is set', async () => {
    const res = await service.sendOtp('670000999', '123456');
    expect(twilio.sendWhatsApp).toHaveBeenCalledWith(
      '+237670000999',
      expect.stringContaining('123456'),
      expect.any(String),
    );
    expect(res.providerMessageId).toBe('SMreal');
  });

  it('bypasses (logs only) when OTP_DEV_BYPASS=true — global kill-switch', async () => {
    process.env.OTP_DEV_BYPASS = 'true';
    const res = await service.sendOtp('670000999', '123456');
    expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
    expect(res.providerMessageId).toMatch(/^dev-/);
  });

  it('bypasses ONLY phones in OTP_BYPASS_PHONES — others still hit Twilio', async () => {
    process.env.OTP_BYPASS_PHONES = '+237670000101,+237670000201';

    const bypassed = await service.sendOtp('670000101', '111111');
    expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
    expect(bypassed.providerMessageId).toMatch(/^dev-/);

    const real = await service.sendOtp('670000999', '222222');
    expect(twilio.sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(twilio.sendWhatsApp).toHaveBeenCalledWith(
      '+237670000999',
      expect.stringContaining('222222'),
      expect.any(String),
    );
    expect(real.providerMessageId).toBe('SMreal');
  });

  it('normalizes allowlist entries to E.164 — bare 9-digit matches +237 input', async () => {
    // Allowlist written without country code — the parser must add +237 so
    // it matches the E.164-normalized request phone.
    process.env.OTP_BYPASS_PHONES = '670000101, 670000201';
    await service.sendOtp('+237670000101', '333333');
    expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('treats empty / whitespace OTP_BYPASS_PHONES as "everyone goes through Twilio"', async () => {
    process.env.OTP_BYPASS_PHONES = '   ,  ,';
    await service.sendOtp('670000101', '444444');
    expect(twilio.sendWhatsApp).toHaveBeenCalled();
  });
});
