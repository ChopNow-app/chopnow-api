import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnvService } from '../config/env.service';
import { CampayCircuitBreakerService } from './campay-circuit-breaker.service';

/**
 * Campay client. POC validated 2026-04-13 (poc-1-campay) — see results.md.
 *
 * Token lifecycle: Campay tokens are short-lived (default 1h). We cache one
 * per process and refresh ~5min before expiry. A force-refresh after 401 is
 * straightforward but not needed at MVP volumes.
 */

export interface CollectRequest {
  amountXAF: number;
  payerPhone: string; // E.164 (e.g. +237670000000)
  description: string;
  externalReference: string;
  webhookUrl?: string;
}

export interface CollectResponse {
  /** Campay-issued reference for this transaction (paymentReference on Order). */
  reference: string;
  /** Initial status from Campay — usually PENDING. */
  status: string;
}

/** Outbound transfer request — platform → MSISDN (vendor or rider payout). */
export interface TransferRequest {
  amountXAF: number;
  /** Destination MoMo number (E.164). */
  toPhone: string;
  description: string;
  /** Our own payout id; Campay echoes it back so we can correlate webhooks. */
  externalReference: string;
  /** Optional per-call webhook URL — overrides the global one configured on Campay. */
  webhookUrl?: string;
}

export interface TransferResponse {
  /** Campay-issued reference, persisted on VendorPayout.campayRef / RiderPayout.campayRef. */
  reference: string;
  /** Initial status from Campay — usually PENDING. */
  status: string;
}

/** Refund request — outbound to customer MSISDN. */
export interface RefundRequest {
  amountXAF: number;
  /** Customer's payer phone (E.164). */
  toPhone: string;
  description: string;
  /** Our own order id used as the externalReference (Campay echoes it back). */
  externalReference: string;
  webhookUrl?: string;
}

export interface RefundResponse {
  /** Campay-issued reference, persisted on Order.refundCampayRef. */
  reference: string;
  status: string;
}

/** Shape of the incoming webhook payload (the bits we care about). */
export interface CampayWebhookPayload {
  status: 'SUCCESSFUL' | 'FAILED' | 'CANCELLED' | 'PENDING' | string;
  reference?: string;
  external_reference?: string;
  amount?: string | number;
  operator?: string;
  phone_number?: string;
  signature?: string;
}

@Injectable()
export class CampayService {
  private token: string | null = null;
  // Refresh ~5min before declared expiry — Campay tokens typically run 1h.
  private tokenExpiresAt = 0;

  // S3 #89: cache the Campay float balance for 60s. The transfer worker
  // calls this once per tick; we don't want to hammer Campay /balance/.
  private balanceXAF: number | null = null;
  private balanceFetchedAt = 0;
  private static readonly BALANCE_TTL_MS = 60_000;

  constructor(
    @InjectPinoLogger(CampayService.name) private readonly logger: PinoLogger,
    private readonly env: EnvService,
    private readonly breaker: CampayCircuitBreakerService,
  ) {}

  async initiateCollect(req: CollectRequest): Promise<CollectResponse> {
    return this.breaker.wrap('initiateCollect', () => this.initiateCollectImpl(req));
  }

  private async initiateCollectImpl(req: CollectRequest): Promise<CollectResponse> {
    const cfg = this.env.requireCampay();
    const token = await this.getToken();

    const body: Record<string, unknown> = {
      amount: String(req.amountXAF),
      from: req.payerPhone,
      description: req.description,
      external_reference: req.externalReference,
    };
    if (req.webhookUrl) body.webhook = req.webhookUrl;

    const res = await fetch(`${cfg.apiUrl}/collect/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
      body: JSON.stringify(body),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.status === 'FAILED') {
      this.logger.error(
        {
          event: 'campay_collect_failed',
          httpStatus: res.status,
          externalReference: req.externalReference,
          response: data,
        },
        'Campay collect call failed',
      );
      throw new Error(
        typeof data.message === 'string' ? data.message : `campay_http_${res.status}`,
      );
    }

    const reference = data.reference as string | undefined;
    if (!reference) {
      this.logger.error(
        {
          event: 'campay_collect_missing_reference',
          externalReference: req.externalReference,
          response: data,
        },
        'Campay collect response missing reference field',
      );
      throw new Error('campay_missing_reference');
    }
    return { reference, status: (data.status as string | undefined) ?? 'PENDING' };
  }

  // Outbound transfer (Story 7.4 / chopnow-api#216). Calls Campay's
  // /withdraw/ endpoint. POC-1 only validated /collect/ (inbound) — the
  // outbound side ships against documented Campay shape and lights up
  // once Campay's outbound tier is provisioned post-RCCM (#181).
  //
  // Webhook for the resulting status callback is registered separately
  // at POST /webhooks/campay/transfer.
  async initiateTransfer(req: TransferRequest): Promise<TransferResponse> {
    return this.breaker.wrap('initiateTransfer', () => this.initiateTransferImpl(req));
  }

  private async initiateTransferImpl(req: TransferRequest): Promise<TransferResponse> {
    const cfg = this.env.requireCampay();
    const token = await this.getToken();

    const body: Record<string, unknown> = {
      amount: String(req.amountXAF),
      to: req.toPhone,
      description: req.description,
      external_reference: req.externalReference,
    };
    if (req.webhookUrl) body.webhook = req.webhookUrl;

    const res = await fetch(`${cfg.apiUrl}/withdraw/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
      body: JSON.stringify(body),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.status === 'FAILED') {
      this.logger.error(
        {
          event: 'campay_transfer_failed',
          httpStatus: res.status,
          externalReference: req.externalReference,
          response: data,
        },
        'Campay transfer call failed',
      );
      throw new Error(
        typeof data.message === 'string' ? data.message : `campay_http_${res.status}`,
      );
    }

    const reference = data.reference as string | undefined;
    if (!reference) {
      this.logger.error(
        {
          event: 'campay_transfer_missing_reference',
          externalReference: req.externalReference,
          response: data,
        },
        'Campay transfer response missing reference field',
      );
      throw new Error('campay_missing_reference');
    }
    return { reference, status: (data.status as string | undefined) ?? 'PENDING' };
  }

  // Refund (Story 7.10 / chopnow-api#90). Functionally the same shape
  // as an outbound transfer — MoMo refunds aren't a first-class concept
  // at the aggregator level; we just send the customer their money back
  // via /withdraw/. The webhook lands at POST /webhooks/campay/refund
  // and the description carries 'refund' so the customer sees a
  // recognizable label.
  async initiateRefund(req: RefundRequest): Promise<RefundResponse> {
    return this.breaker.wrap('initiateRefund', () => this.initiateRefundImpl(req));
  }

  private async initiateRefundImpl(req: RefundRequest): Promise<RefundResponse> {
    const cfg = this.env.requireCampay();
    const token = await this.getToken();

    const body: Record<string, unknown> = {
      amount: String(req.amountXAF),
      to: req.toPhone,
      description: req.description,
      external_reference: req.externalReference,
    };
    if (req.webhookUrl) body.webhook = req.webhookUrl;

    const res = await fetch(`${cfg.apiUrl}/withdraw/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
      body: JSON.stringify(body),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.status === 'FAILED') {
      this.logger.error(
        {
          event: 'campay_refund_failed',
          httpStatus: res.status,
          externalReference: req.externalReference,
          response: data,
        },
        'Campay refund call failed',
      );
      throw new Error(
        typeof data.message === 'string' ? data.message : `campay_http_${res.status}`,
      );
    }

    const reference = data.reference as string | undefined;
    if (!reference) {
      this.logger.error(
        {
          event: 'campay_refund_missing_reference',
          externalReference: req.externalReference,
          response: data,
        },
        'Campay refund response missing reference field',
      );
      throw new Error('campay_missing_reference');
    }
    return { reference, status: (data.status as string | undefined) ?? 'PENDING' };
  }

  // Campay platform float balance (Story 7.9 / chopnow-api#89). Returned
  // in XAF integer for easy comparison against payout netXAF. Cached for
  // 60s — the payout worker checks at most once per tick.
  //
  // forceRefresh=true bypasses the cache (admin manual refresh in the
  // financial dashboard).
  async getBalance(opts: { forceRefresh?: boolean } = {}): Promise<number> {
    return this.breaker.wrap('getBalance', () => this.getBalanceImpl(opts));
  }

  private async getBalanceImpl(opts: { forceRefresh?: boolean } = {}): Promise<number> {
    const now = Date.now();
    if (
      !opts.forceRefresh &&
      this.balanceXAF !== null &&
      now - this.balanceFetchedAt < CampayService.BALANCE_TTL_MS
    ) {
      return this.balanceXAF;
    }

    const cfg = this.env.requireCampay();
    const token = await this.getToken();
    const res = await fetch(`${cfg.apiUrl}/balance/`, {
      method: 'GET',
      headers: { Authorization: `Token ${token}` },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      this.logger.error(
        { event: 'campay_balance_fetch_failed', httpStatus: res.status, response: data },
        'Campay balance call failed',
      );
      throw new Error(
        typeof data.message === 'string' ? data.message : `campay_http_${res.status}`,
      );
    }

    // Campay's balance response shape varies by tier; we look for the
    // most common keys. Fall back to total_balance / balance. All values
    // expected in XAF.
    const raw = (data.total_balance ?? data.balance ?? data.amount ?? 0) as number | string;
    const xaf = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(xaf)) {
      this.logger.error(
        { event: 'campay_balance_parse_failed', response: data },
        'Campay balance response unparseable',
      );
      throw new Error('campay_balance_invalid');
    }

    this.balanceXAF = Math.round(xaf);
    this.balanceFetchedAt = now;
    return this.balanceXAF;
  }

  // ── private ──────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) return this.token;

    const cfg = this.env.requireCampay();
    const res = await fetch(`${cfg.apiUrl}/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Campay auth failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { token?: string; expires_in?: number };
    if (!data.token) throw new Error('Campay returned no token');

    this.token = data.token;
    // Default 1h if not provided, refreshing 5min early.
    const lifetimeSec = data.expires_in ?? 3600;
    this.tokenExpiresAt = now + Math.max(60, lifetimeSec - 300) * 1000;
    return this.token;
  }
}
