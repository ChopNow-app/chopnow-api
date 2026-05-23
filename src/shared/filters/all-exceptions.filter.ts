import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Request, Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

/**
 * A snake_case identifier — what every bare-string throw in this
 * codebase actually means (`'vendor_not_found'`, `'invalid_signature'`,
 * etc.). Used to detect those throws and promote the string to the
 * `code` field on the response so the frontend has a stable identifier
 * regardless of whether the throw site used the structured or bare form.
 */
const SNAKE_CASE_CODE = /^[a-z][a-z0-9_]*$/;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger(AllExceptionsFilter.name) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // NestJS' HttpException.getResponse() returns either:
    //   - a string (when caller did `throw new BadRequestException('foo')`)
    //   - an object `{ statusCode, message, error }` (NestJS's default mapping)
    //   - the caller's object verbatim (when caller did
    //     `throw new BadRequestException({ code, message })`)
    // Normalize to an object so the spread + code-promotion logic below
    // has one shape to work with.
    const rawResponse =
      exception instanceof HttpException
        ? exception.getResponse()
        : { message: 'Internal server error' };
    const body: Record<string, unknown> =
      typeof rawResponse === 'object' && rawResponse !== null
        ? (rawResponse as Record<string, unknown>)
        : { message: String(rawResponse) };

    // 5xx → log full context with stack trace + ship to Sentry. Stack
    // NEVER leaves the server in the response: the body below uses the
    // (already-sanitized) `body.message`, not the exception.
    //
    // Sentry.captureException is a no-op when the SDK wasn't initialised
    // (no SENTRY_DSN set) — safe in CI, dev, and any env where Sentry
    // isn't wanted. When configured, every 5xx becomes a Sentry issue
    // grouped by stack so we can see which throws are firing most.
    if (status >= 500) {
      this.logger.error(
        {
          event: 'unhandled_5xx',
          method: request.method,
          path: request.url,
          statusCode: status,
          stack: exception instanceof Error ? exception.stack : String(exception),
        },
        'Unhandled exception returned 5xx',
      );
      Sentry.captureException(exception, {
        tags: {
          method: request.method,
          path: request.url,
          status_code: String(status),
        },
      });
    }

    // Promote bare-string throws to a `code` field.
    //
    // ~80 throw sites in the codebase use `throw new X('foo_bar')`
    // where 'foo_bar' is semantically the code (the frontend wants to
    // branch on it). NestJS puts that string into `body.message` not
    // `body.code`. Rather than rewrite every site, the filter detects
    // the snake_case shape and copies it into `code` — non-breaking
    // for callers that already used the structured `{ code, message }`
    // form (we never overwrite an existing `code`), and gives every
    // error a `code` field for the client.
    if (!body.code && typeof body.message === 'string' && SNAKE_CASE_CODE.test(body.message)) {
      body.code = body.message;
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...body,
    });
  }
}
