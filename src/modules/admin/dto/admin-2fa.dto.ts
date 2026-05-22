import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * Phase A1 — TOTP login step 2. Redeems the challenge issued by
 * /admin/auth/login when the admin has TOTP enrolled.
 *
 * `code` is either a 6-digit TOTP code OR a single-use recovery code in
 * `XXXX-YYYY` format. The `isRecoveryCode` flag tells the server which
 * verification path to take.
 */
export class VerifyAdminTotpDto {
  @ApiProperty({
    description: 'Opaque challenge token returned by /admin/auth/login when totp_required.',
  })
  @IsString()
  @Length(20, 64)
  challenge!: string;

  @ApiProperty({
    description: '6-digit TOTP from the authenticator app, OR a recovery code in XXXX-YYYY format.',
    example: '123456',
  })
  @IsString()
  // Accept either 6 digits OR a 9-char `XXXX-YYYY` string; the service-level
  // validator does the real work.
  @Matches(/^(\d{6}|[A-Z2-9]{4}-[A-Z2-9]{4})$/, {
    message: 'code must be 6 digits or a recovery code (XXXX-YYYY).',
  })
  code!: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isRecoveryCode?: boolean;
}

/**
 * Phase A1 — confirm enrollment by submitting the first authenticator code.
 */
export class ConfirmAdminTotpDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits.' })
  code!: string;
}
