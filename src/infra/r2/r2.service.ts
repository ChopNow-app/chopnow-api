import { Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { randomUUID } from 'crypto';
import { EnvService } from '../config/env.service';

export interface UploadResult {
  key: string;
  publicUrl?: string;
}

/**
 * Cloudflare R2 client (S3-compatible). Used for vendor photos, KYC documents,
 * delivery proof images. Two buckets convention:
 *   - public bucket: vendor logos, item photos (served via CDN)
 *   - private bucket (e.g. "rider-kyc"): KYC docs (admin-signed-URL access only)
 *
 * Lazily initialised so the app can boot without R2 configured.
 */
@Injectable()
export class R2Service {
  private _client: S3Client | null = null;

  constructor(private readonly env: EnvService) {}

  private get client(): S3Client {
    if (this._client) return this._client;
    const r2 = this.env.r2;
    if (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey) {
      throw new Error('R2 is not configured — set R2_* env vars');
    }
    this._client = new S3Client({
      region: 'auto',
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });
    return this._client;
  }

  private requireBucket(): string {
    const b = this.env.r2.bucket;
    if (!b) throw new Error('R2_BUCKET is not set');
    return b;
  }

  /**
   * Optimise + upload an image. Resizes to a max edge, strips metadata,
   * outputs WebP for everything (smaller, well-supported on Android Chrome).
   *
   * Returns the storage key. Caller is responsible for persisting it on the
   * vendor/item/rider row.
   */
  async uploadImage(
    inputBuffer: Buffer,
    opts: {
      keyPrefix: string;
      maxEdge?: number;
      quality?: number;
      contentType?: string;
    },
  ): Promise<UploadResult> {
    const optimized = await sharp(inputBuffer)
      .rotate() // honour EXIF orientation before stripping
      .resize({
        width: opts.maxEdge ?? 1280,
        height: opts.maxEdge ?? 1280,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: opts.quality ?? 80 })
      .toBuffer();

    const key = `${opts.keyPrefix}/${randomUUID()}.webp`;
    const bucket = this.requireBucket();

    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: optimized,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    return { key };
  }

  /**
   * Upload a raw object (no image processing). Use for non-image files —
   * e.g. KYC PDFs if we ever support them.
   */
  async uploadRaw(buffer: Buffer, key: string, contentType: string): Promise<UploadResult> {
    const bucket = this.requireBucket();
    await this.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }),
    );
    return { key };
  }

  /** Generate a time-limited signed URL for a private object (e.g. KYC photo). */
  async signedDownloadUrl(key: string, ttlSeconds = 300): Promise<string> {
    const bucket = this.requireBucket();
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  async delete(key: string): Promise<void> {
    const bucket = this.requireBucket();
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
