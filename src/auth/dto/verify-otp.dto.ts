import { IsString, Length, Matches } from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  @Matches(/^6[5-9]\d{7}$/)
  phone!: string;

  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  @Matches(/^\d{6}$/)
  code!: string;
}
