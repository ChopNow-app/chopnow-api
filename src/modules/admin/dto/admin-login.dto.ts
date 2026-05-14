import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Story 1.6 — Admin Authentication.
 *
 * Email + password (no phone OTP — admins may be non-Cameroon).
 * Password rules: ≥12 chars, ≥1 uppercase, ≥1 digit, ≥1 special.
 */
export class AdminLoginDto {
  @ApiProperty({ example: 'admin@chopnow.app' })
  @IsEmail()
  @MaxLength(120)
  email!: string;

  @ApiProperty({
    description: 'Min 12 chars, must include uppercase, digit, and special char.',
    example: 'StrongPwd!2026',
  })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  // class-validator's three regex passes — keeps each rule independently
  // surfaced in the error response so the UI can highlight the missing class.
  @Matches(/[A-Z]/, { message: 'password must contain at least one uppercase letter' })
  @Matches(/\d/, { message: 'password must contain at least one digit' })
  @Matches(/[^A-Za-z0-9]/, { message: 'password must contain at least one special character' })
  password!: string;
}
