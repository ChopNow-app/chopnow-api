import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Histogram } from 'prom-client';
import { Observable, tap } from 'rxjs';

import { HTTP_REQUEST_DURATION_SECONDS } from './metrics.constants';

/**
 * Records every HTTP request's duration into the
 * `http_request_duration_seconds` histogram, labelled by method, route
 * template, and response status code.
 *
 * Why "route template" not "raw url": labelling by raw URL would create
 * a new histogram series per orderId, exploding cardinality (Prometheus
 * starts hurting at ~10k series per metric). We use NestJS's route
 * resolution (`request.route.path`) which gives `/api/v1/orders/:orderId`
 * regardless of the actual id — bounded cardinality, useful aggregates.
 *
 * Registered globally in `app.module.ts` via APP_INTERCEPTOR so every
 * controller route is automatically observed.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(
    @Inject(HTTP_REQUEST_DURATION_SECONDS)
    private readonly histogram: Histogram<string>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Only observe HTTP traffic — gRPC / WebSocket / cron contexts have
    // no request object and would crash the labelling below.
    if (context.getType() !== 'http') return next.handle();

    const start = process.hrtime.bigint();
    const req = context.switchToHttp().getRequest<Request & { route?: { path?: string } }>();
    const res = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      tap({
        next: () => this.record(start, req, res.statusCode),
        error: (err: unknown) => {
          // For exception paths, the AllExceptionsFilter has already
          // set the status when it formats the response — but at the
          // moment the interceptor's error tap fires, NestJS hasn't
          // run the filter yet. Use the exception's status if it's an
          // HttpException, else attribute to 500.
          const status =
            err && typeof err === 'object' && 'getStatus' in err
              ? (err as { getStatus(): number }).getStatus()
              : 500;
          this.record(start, req, status);
        },
      }),
    );
  }

  private record(
    start: bigint,
    req: Request & { route?: { path?: string } },
    status: number,
  ): void {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path ?? req.url ?? 'unknown';
    this.histogram.observe({ method: req.method, route, status: String(status) }, durationSec);
  }
}
