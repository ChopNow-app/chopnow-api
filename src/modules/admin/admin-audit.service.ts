import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Phase A2 — admin audit log. Single primitive: `record(...)`. Wired into
 * every admin write endpoint via `AdminAuditInterceptor`. Read endpoint is
 * `GET /admin/audit-logs` (paginated, filterable).
 *
 * Failure mode: insert errors are warn-logged and swallowed. A failure to
 * write the audit row must NOT break the admin action itself — if the
 * row goes missing, the structured log line is the fallback record.
 */

const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'passwordHash',
  'code',
  'recoveryCode',
  'recoverycode',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'secret',
  'pin',
  'twofactorcode',
  'twoFactorCode',
]);

export interface AuditLogInput {
  adminId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  payload?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  outcome: 'success' | 'error';
  errorCode?: string | null;
}

@Injectable()
export class AdminAuditService {
  constructor(
    @InjectPinoLogger(AdminAuditService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
  ) {}

  async record(input: AuditLogInput): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          adminId: input.adminId,
          action: input.action,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          payload: input.payload
            ? (sanitize(input.payload) as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          outcome: input.outcome,
          errorCode: input.errorCode ?? null,
        },
      });
    } catch (err) {
      // Audit insert failure must not break the admin action. Log loud so
      // the gap shows up in structured logs.
      this.logger.warn(
        {
          event: 'admin_audit_insert_failed',
          adminId: input.adminId,
          action: input.action,
          error: String(err),
        },
        'Admin audit row insert failed — fallback to structured log only',
      );
    }
  }

  /**
   * Paginated read for the admin UI. SUPER_ADMIN-only filter is applied at
   * the controller level; this method trusts the caller has been gated.
   */
  async list(params: {
    adminId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; rows: Array<AdminAuditRow> }> {
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(params.adminId ? { adminId: params.adminId } : {}),
      ...(params.action ? { action: params.action } : {}),
      ...(params.targetType ? { targetType: params.targetType } : {}),
      ...(params.targetId ? { targetId: params.targetId } : {}),
    };
    const take = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const skip = Math.max(params.offset ?? 0, 0);
    const [total, rows] = await Promise.all([
      this.prisma.adminAuditLog.count({ where }),
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          admin: { select: { id: true, email: true, displayName: true } },
        },
      }),
    ]);
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        adminId: r.adminId,
        adminEmail: r.admin.email,
        adminDisplayName: r.admin.displayName,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        payload: r.payload,
        ip: r.ip,
        userAgent: r.userAgent,
        outcome: r.outcome,
        errorCode: r.errorCode,
        createdAt: r.createdAt,
      })),
    };
  }
}

export interface AdminAuditRow {
  id: string;
  adminId: string;
  adminEmail: string | null;
  adminDisplayName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payload: Prisma.JsonValue;
  ip: string | null;
  userAgent: string | null;
  outcome: string;
  errorCode: string | null;
  createdAt: Date;
}

/**
 * Recursively walk a value and replace sensitive-keyed fields with
 * [REDACTED]. Handles nested objects + arrays. Keeps the structure so
 * a reviewer can still see "there WAS a password field" without
 * leaking the value.
 */
export function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k) || SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = sanitize(v);
    }
  }
  return out;
}
