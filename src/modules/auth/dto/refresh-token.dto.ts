import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Phase B1 — refresh token is now carried in the HttpOnly `chopnow_rt`
 * cookie. The body field is kept optional during the frontend cutover —
 * the existing PWA still sends it from localStorage. Either source is
 * accepted; the cookie wins when both are present.
 */
export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      'Refresh JWT. Optional: the HttpOnly chopnow_rt cookie is the preferred source. ' +
      'Body field accepted for backward compatibility while the PWA cuts over.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;
}
