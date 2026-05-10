import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

// Same rule as RequestOtpDto: Cameroon local OR international E.164.
const PHONE_PATTERN = /^(?:6[5-9]\d{7}|\+?[1-9]\d{7,14})$/;

export class VerifyOtpDto {
  @ApiProperty({
    example: '670000000',
    pattern: '^(?:6[5-9]\\d{7}|\\+?[1-9]\\d{7,14})$',
  })
  @IsString()
  @Matches(PHONE_PATTERN)
  phone!: string;

  @ApiProperty({ description: '6-digit OTP code', example: '123456', pattern: '^\\d{6}$' })
  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  @Matches(/^\d{6}$/)
  code!: string;
}
