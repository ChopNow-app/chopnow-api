import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnvService } from '../config/env.service';

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

  constructor(
    @InjectPinoLogger(CampayService.name) private readonly logger: PinoLogger,
    private readonly env: EnvService,
  ) {}

  async initiateCollect(req: CollectRequest): Promise<CollectResponse> {
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
