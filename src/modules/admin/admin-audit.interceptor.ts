import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { catchError, Observable, tap, throwError } from 'rxjs';
import { AdminAuditService } from './admin-audit.service';

/**
 * Auto-logs every admin write request to the audit table. Applied via
 * `@UseInterceptors(AdminAuditInterceptor)` on AdminController classes.
 *
 * Action derivation: `<controller short name>.<handler name>` — e.g.
 * AdminValidationController.approveVendor → "validation.approveVendor".
 * Concrete; readable in logs; doesn't require per-method @AuditLog
 * decoration.
 *
 * Targets: best-effort. Reads `req.params` for the first uuid-shaped
 * key — for endpoints like `/admin/vendors/:vendorId/approve` this
 * yields the vendor id. Endpoints that have no path param leave the
 * targetId null (action alone is enough audit signal for those).
 *
 * Read endpoints (GET / HEAD) are skipped — they have no side effects.
 *
 * Failure modes: an audit insert failure does NOT break the admin
 * action (handled inside AdminAuditService).
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AdminAuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request & { user?: { id?: string } }>();

    // Skip safe methods + unauthenticated requests (no admin to attribute).
    if (req.method === 'GET' || req.method === 'HEAD') {
      return next.handle();
    }
    const adminId = req.user?.id;
    if (!adminId) {
      return next.handle();
    }

    const controllerName = ctx.getClass().name;
    const handlerName = ctx.getHandler().name;
    const action = `${shortController(controllerName)}.${handlerName}`;
    // Cast: Express types params as ParamsDictionary (string | string[]);
    // our routes only ever bind path params to scalar strings, so the
    // tighter type is safe in practice.
    const params = req.params as unknown as Record<string, string>;
    const { targetType, targetId } = deriveTarget(controllerName, params);
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    const payload = mergedPayload(req);

    return next.handle().pipe(
      tap(() => {
        void this.audit.record({
          adminId,
          action,
          targetType,
          targetId,
          payload,
          ip,
          userAgent,
          outcome: 'success',
        });
      }),
      catchError((err) => {
        // err.getResponse() exposes the body for HttpException; pull the
        // `code` field if present so the audit row reflects the same
        // error code the client sees.
        let errorCode: string | null = null;
        const errResponse: unknown = (err as { getResponse?: () => unknown }).getResponse?.();
        if (errResponse && typeof errResponse === 'object' && 'code' in errResponse) {
          errorCode = String((errResponse as { code: unknown }).code);
        } else if (typeof err?.code === 'string') {
          errorCode = err.code;
        } else {
          errorCode = err?.constructor?.name ?? 'Error';
        }
        void this.audit.record({
          adminId,
          action,
          targetType,
          targetId,
          payload,
          ip,
          userAgent,
          outcome: 'error',
          errorCode,
        });
        return throwError(() => err);
      }),
    );
  }
}

function shortController(name: string): string {
  // AdminValidationController → "validation"
  // AdminFinanceController    → "finance"
  // AdminRiderFraudController → "riderFraud"
  // AdminAuthController       → "auth"
  return name
    .replace(/^Admin/, '')
    .replace(/Controller$/, '')
    .replace(/^./, (c) => c.toLowerCase());
}

function deriveTarget(
  controllerName: string,
  params: Record<string, string> | undefined,
): { targetType: string | null; targetId: string | null } {
  if (!params) return { targetType: null, targetId: null };
  // Map controller name to a target type for the common cases. Anything
  // we don't recognise leaves targetType null — the action name still
  // carries the info.
  const byController: Record<string, string> = {
    AdminValidationController: 'vendor', // refined below if a riderId path is present
    AdminFinanceController: 'finance',
    AdminRiderFraudController: 'order',
    AdminAuthController: 'admin',
  };
  let targetType: string | null = byController[controllerName] ?? null;
  let targetId: string | null = null;

  // Prefer the first uuid-shaped value as the target id.
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') continue;
    if (/^[a-f0-9-]{36}$/i.test(value)) {
      targetId = value;
      // Refine targetType from the param name for AdminValidationController
      // (it has both /vendors/:vendorId and /riders/:riderId paths).
      if (key === 'riderId') targetType = 'rider';
      else if (key === 'vendorId') targetType = 'vendor';
      else if (key === 'orderId') targetType = 'order';
      else if (key === 'requestId') targetType = 'cashoutRequest';
      else if (key === 'payoutId') targetType = 'payout';
      break;
    }
  }

  return { targetType, targetId };
}

/**
 * Audit payload = body merged with any non-uuid query params. Sanitisation
 * happens inside AdminAuditService.record so the interceptor doesn't
 * duplicate the redaction logic.
 */
function mergedPayload(req: Request): Record<string, unknown> | undefined {
  const body = req.body && typeof req.body === 'object' ? req.body : undefined;
  const query = req.query && typeof req.query === 'object' ? req.query : undefined;
  if (!body && (!query || Object.keys(query).length === 0)) return undefined;
  return { body, query };
}
