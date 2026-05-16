import { Controller, Get, Header, NotFoundException, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Response } from 'express';
import type { Readable } from 'node:stream';
import { Public } from '../../shared/decorators/public.decorator';
import { EnvService } from '../config/env.service';

const ALLOWED_PREFIXES = ['vendor-profile/', 'item-photo/'] as const;
const MEDIA_CACHE = 'public, max-age=86400, immutable';

/**
 * Public read proxy for the R2 media bucket. Streams WebP bytes for the
 * prefixes that consumers need to render (`vendor-profile/`, `item-photo/`).
 * KYC docs are stored under different prefixes and are NOT proxied here —
 * those keep the signed-URL admin-only flow.
 *
 * The frontend rewrites /r2/:path* → /api/media/:path*, so component code
 * stays at `src={`/r2/${key}`}`. Throttled at 60/min/IP — generous enough
 * for a catalogue grid (each vendor card = 1 image) and stingy enough to
 * deter scraping.
 */
@Controller('media')
export class MediaController {
  private _client: S3Client | null = null;

  constructor(private readonly env: EnvService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header('Cache-Control', MEDIA_CACHE)
  @Header('Content-Type', 'image/webp')
  @Get(':prefix/:name')
  async streamObject(
    @Param('prefix') prefix: string,
    @Param('name') name: string,
    @Res() res: Response,
  ): Promise<void> {
    const key = `${prefix}/${name}`;
    if (!ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
      throw new NotFoundException();
    }

    const bucket = this.env.r2.bucket;
    if (!bucket) throw new NotFoundException();

    const obj = await this.client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = obj.Body as Readable | undefined;
    if (!body) throw new NotFoundException();

    // Trust R2's stored Content-Type for non-image overrides if needed; for
    // the WebP-only image pipeline the header decorator above is correct.
    body.pipe(res);
  }

  private client(): S3Client {
    if (this._client) return this._client;
    const r2 = this.env.r2;
    if (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey) {
      throw new NotFoundException();
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
}
