import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

// Accept either:
//   - Cameroon local format: 9 digits starting with 65–69 (e.g. 670000000) → toE164 prepends +237
//   - International E.164: optional leading '+' then country code + number, 8–15 digits
// Foreign visitors (FR/BE/etc.) must use their own number while in Cameroon.
const PHONE_PATTERN = /^(?:6[5-9]\d{7}|\+?[1-9]\d{7,14})$/;

export class RequestOtpDto {
  @ApiProperty({
    description:
      'Phone number — Cameroon local (e.g. 670000000) or international E.164 (e.g. +33695412820).',
    example: '670000000',
    pattern: '^(?:6[5-9]\\d{7}|\\+?[1-9]\\d{7,14})$',
  })
  @IsString()
  @Matches(PHONE_PATTERN, {
    message:
      'Phone must be a 9-digit Cameroon number (e.g. 670000000) or an E.164 international number (e.g. +33695412820)',
  })
  phone!: string;
}
