import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Device } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { EnvService } from '../../infra/config/env.service';
import { MailService } from '../../infra/mail/mail.service';

export interface DeviceMeta {
  /** Value of the `chopnow_did` cookie if the client sent one. Null on
   *  first sign-in from a fresh device. */
  deviceCookie: string | null;
  /** Best-effort client IP (express's `req.ip`, honors `trust proxy`). */
  ipAddress: string | null;
  /** Raw User-Agent header. We sha256 it before storage to keep PII
   *  surface small but keep a human-readable label for the alert email. */
  userAgent: string | null;
}

export interface ResolvedDevice {
  device: Device;
  /** True when this sign-in just created the Device row — used by the
   *  alert email path so we only mail on genuinely new devices. */
  isNew: boolean;
}

/**
 * Phase C1 — device fingerprinting for refresh tokens.
 *
 * Every sign-in / refresh resolves an associated `Device` row. The
 * device's id is the value stored in the HttpOnly `chopnow_did` cookie
 * (random UUID, doubles as both the surrogate key and the cookie
 * value). RefreshToken rows link back via `RefreshToken.deviceId`.
 *
 * Phase C2 — when verifyOtp lands on a brand-new Device, the service
 * fires a "Nouvelle connexion détectée" email so an account takeover
 * is visible to the legitimate user.
 */
@Injectable()
export class DeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly mail: MailService,
    @InjectPinoLogger(DeviceService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Find-or-create the Device row for this sign-in. Returns `isNew: true`
   * when the row was just created — used by callers to decide whether
   * to fire a new-device alert email.
   */
  async resolveDevice(userId: string, meta: DeviceMeta): Promise<ResolvedDevice> {
    const userAgentHash = meta.userAgent
      ? createHash('sha256').update(meta.userAgent).digest('hex')
      : null;
    const userAgentLabel = meta.userAgent ? summarizeUserAgent(meta.userAgent) : null;

    // Existing device — the cookie value must match a row that belongs
    // to this same user. Cross-user reuse of a cookie value would be
    // either a bug or a deliberate hand-off; in either case we ignore
    // the cookie and mint a fresh device.
    if (meta.deviceCookie) {
      const existing = await this.prisma.device.findFirst({
        where: { id: meta.deviceCookie, userId },
      });
      if (existing) {
        const updated = await this.prisma.device.update({
          where: { id: existing.id },
          data: {
            userAgentHash,
            userAgentLabel,
            ipAddress: meta.ipAddress,
            lastSeenAt: new Date(),
          },
        });
        return { device: updated, isNew: false };
      }
    }

    const created = await this.prisma.device.create({
      data: {
        userId,
        userAgentHash,
        userAgentLabel,
        ipAddress: meta.ipAddress,
      },
    });
    return { device: created, isNew: true };
  }

  /**
   * Phase C2 — fire-and-forget alert email when a new device successfully
   * signs in. Failures are logged but never thrown — a flaky Resend
   * shouldn't strand the user post-verify-otp.
   *
   * Resolves to the email user's User.email; if unset (phone-only
   * accounts, which is the default in the pilot) nothing is sent.
   */
  async sendNewDeviceAlert(userId: string, device: Device): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true },
    });
    if (!user?.email) {
      this.logger.info(
        { event: 'new_device_alert_skipped_no_email', userId, deviceId: device.id },
        'New-device alert skipped: user has no email on file',
      );
      return;
    }

    const subject = 'Nouvelle connexion détectée — ChopNow';
    const when = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Africa/Douala',
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(device.firstSeenAt);
    const where = device.ipAddress ? `IP ${device.ipAddress}` : 'adresse IP inconnue';
    const ua = device.userAgentLabel ?? 'appareil inconnu';
    const appUrl = this.env.appUrl;

    const html = `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #E11D2A; margin: 0 0 8px;">Nouvelle connexion sur ton compte</h2>
        <p>Salut${user.displayName ? ` ${escapeHtml(user.displayName)}` : ''},</p>
        <p>Une nouvelle connexion vient d'être enregistrée sur ton compte&nbsp;:</p>
        <ul style="line-height: 1.6;">
          <li><strong>Date&nbsp;:</strong> ${when}</li>
          <li><strong>Appareil&nbsp;:</strong> ${escapeHtml(ua)}</li>
          <li><strong>Origine&nbsp;:</strong> ${escapeHtml(where)}</li>
        </ul>
        <p>Si c'était toi, tu peux ignorer ce message.</p>
        <p>
          Si ce n'était <strong>pas toi</strong>, déconnecte-toi de tous les appareils
          tout de suite&nbsp;: <a href="${appUrl}/account?next=revoke-all">${appUrl}/account</a>
          puis change ton numéro avec un super-admin.
        </p>
        <p style="color: #6B7280; font-size: 12px; margin-top: 24px;">
          ChopNow — Mange sans attendre.
        </p>
      </div>
    `;
    const text =
      `Nouvelle connexion sur ton compte ChopNow\n\n` +
      `Date : ${when}\n` +
      `Appareil : ${ua}\n` +
      `Origine : ${where}\n\n` +
      `Si ce n'était pas toi, déconnecte-toi de tous les appareils : ${appUrl}/account`;

    try {
      await this.mail.send({ to: user.email, subject, html, text });
      this.logger.info(
        { event: 'new_device_alert_sent', userId, deviceId: device.id },
        'New-device alert email sent',
      );
    } catch (err) {
      this.logger.warn(
        { event: 'new_device_alert_failed', userId, deviceId: device.id, error: String(err) },
        'New-device alert email failed to send',
      );
    }
  }
}

/**
 * Best-effort short label from a User-Agent string. Resend emails
 * shouldn't contain a 200-char UA blob; this trims it down to the
 * useful signal ("iPhone, Safari", "Chrome on Android", …) and falls
 * back to the first 80 chars when no known pattern matches.
 */
export function summarizeUserAgent(ua: string): string {
  const trimmed = ua.trim();
  // Cheap pattern recognition — covers the four browsers we expect at
  // pilot launch (iOS Safari, Android Chrome, desktop Chrome, desktop
  // Safari) without pulling a UA-parsing library.
  const platform = /iPhone|iPad/.test(trimmed)
    ? 'iPhone/iPad'
    : /Android/.test(trimmed)
      ? 'Android'
      : /Macintosh/.test(trimmed)
        ? 'Mac'
        : /Windows NT/.test(trimmed)
          ? 'Windows'
          : /Linux/.test(trimmed)
            ? 'Linux'
            : null;
  const browser = /CriOS/.test(trimmed)
    ? 'Chrome'
    : /FxiOS/.test(trimmed)
      ? 'Firefox'
      : /Edg\//.test(trimmed)
        ? 'Edge'
        : /Chrome\//.test(trimmed)
          ? 'Chrome'
          : /Firefox\//.test(trimmed)
            ? 'Firefox'
            : /Safari\//.test(trimmed)
              ? 'Safari'
              : null;
  if (platform && browser) return `${browser} sur ${platform}`;
  if (platform) return platform;
  if (browser) return browser;
  return trimmed.slice(0, 80);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
