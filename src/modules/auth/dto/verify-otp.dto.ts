import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class VerifyOtpDto {
  @ApiProperty({ example: '670000000', pattern: '^6[5-9]\\d{7}$' })
  @IsString()
  @Matches(/^6[5-9]\d{7}$/)
  phone!: string;

  @ApiProperty({ description: '6-digit OTP code', example: '123456', pattern: '^\\d{6}$' })
  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  @Matches(/^\d{6}$/)
  code!: string;
}
