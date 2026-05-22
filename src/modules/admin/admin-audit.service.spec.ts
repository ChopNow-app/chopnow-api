import { AdminAuditService, sanitize } from './admin-audit.service';

const logger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  setContext: jest.fn(),
};

function buildService() {
  const prisma = {
    adminAuditLog: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const service = new AdminAuditService(logger as never, prisma as never);
  return { service, prisma };
}

describe('AdminAuditService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('record', () => {
    it('persists a row with all the supplied fields', async () => {
      const { service, prisma } = buildService();
      await service.record({
        adminId: 'admin-1',
        action: 'validation.approveVendor',
        targetType: 'vendor',
        targetId: 'v-1',
        payload: { body: { foo: 'bar' } },
        ip: '5.6.7.8',
        userAgent: 'curl/8',
        outcome: 'success',
      });
      expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          adminId: 'admin-1',
          action: 'validation.approveVendor',
          targetType: 'vendor',
          targetId: 'v-1',
          outcome: 'success',
          errorCode: null,
        }),
      });
    });

    it('redacts sensitive payload keys before write', async () => {
      const { service, prisma } = buildService();
      await service.record({
        adminId: 'admin-1',
        action: 'auth.confirm2faSetup',
        payload: { body: { code: '123456', other: 'safe' } },
        outcome: 'success',
      });
      const data = prisma.adminAuditLog.create.mock.calls[0][0].data;
      expect(data.payload).toEqual({ body: { code: '[REDACTED]', other: 'safe' } });
    });

    it('swallows DB errors so the admin action still completes', async () => {
      const { service, prisma } = buildService();
      prisma.adminAuditLog.create.mockRejectedValueOnce(new Error('DB down'));
      await expect(
        service.record({ adminId: 'admin-1', action: 'foo.bar', outcome: 'success' }),
      ).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'admin_audit_insert_failed' }),
        expect.any(String),
      );
    });

    it('records an error outcome with errorCode', async () => {
      const { service, prisma } = buildService();
      await service.record({
        adminId: 'admin-1',
        action: 'finance.rejectCashout',
        outcome: 'error',
        errorCode: 'cashout_already_resolved',
      });
      const data = prisma.adminAuditLog.create.mock.calls[0][0].data;
      expect(data.outcome).toBe('error');
      expect(data.errorCode).toBe('cashout_already_resolved');
    });
  });

  describe('list', () => {
    it('caps limit at 200 and clamps to ≥ 1', async () => {
      const { service, prisma } = buildService();
      await service.list({ limit: 9999 });
      expect(prisma.adminAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 200 }),
      );
      await service.list({ limit: 0 });
      expect(prisma.adminAuditLog.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    });

    it('passes filters through to the query', async () => {
      const { service, prisma } = buildService();
      await service.list({ adminId: 'a-1', action: 'foo.bar', targetType: 'vendor' });
      const where = prisma.adminAuditLog.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ adminId: 'a-1', action: 'foo.bar', targetType: 'vendor' });
    });
  });
});

describe('sanitize', () => {
  it('redacts top-level sensitive keys', () => {
    expect(sanitize({ password: 'hunter2', name: 'alice' })).toEqual({
      password: '[REDACTED]',
      name: 'alice',
    });
  });

  it('recursively redacts in nested objects', () => {
    expect(sanitize({ body: { code: '123456', items: [{ token: 'x', qty: 1 }] } })).toEqual({
      body: { code: '[REDACTED]', items: [{ token: '[REDACTED]', qty: 1 }] },
    });
  });

  it('handles arrays', () => {
    expect(sanitize([{ password: 'a' }, { password: 'b' }])).toEqual([
      { password: '[REDACTED]' },
      { password: '[REDACTED]' },
    ]);
  });

  it('leaves non-sensitive keys untouched', () => {
    expect(sanitize({ email: 'a@b', displayName: 'X' })).toEqual({
      email: 'a@b',
      displayName: 'X',
    });
  });

  it('passes primitives + null through', () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeUndefined();
    expect(sanitize(42)).toBe(42);
    expect(sanitize('hello')).toBe('hello');
  });

  it('redacts case-insensitively', () => {
    expect(sanitize({ Password: 'x', accessToken: 'y' })).toEqual({
      Password: '[REDACTED]',
      accessToken: '[REDACTED]',
    });
  });
});
