import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

const PHONE_PATTERN = /^(?:6[5-9]\d{7}|\+?[1-9]\d{7,14})$/;

/** Story 3.3 / 3.4 — payer phone for the Campay USSD prompt. */
export class InitiateMomoPaymentDto {
  @ApiProperty({
    description: 'MTN MoMo or Orange Money number — Cameroon local or E.164.',
    example: '670000000',
  })
  @IsString()
  @Matches(PHONE_PATTERN, {
    message: 'payerPhone must be a 9-digit Cameroon number or E.164 international.',
  })
  payerPhone!: string;
}
