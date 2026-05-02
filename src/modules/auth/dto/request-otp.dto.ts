import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class RequestOtpDto {
  @ApiProperty({
    description: 'Cameroon phone number — 9 digits, must start with 65–69. No country code.',
    example: '670000000',
    pattern: '^6[5-9]\\d{7}$',
  })
  @IsString()
  @Matches(/^6[5-9]\d{7}$/, {
    message: 'Phone must be a 9-digit Cameroon number starting with 65–69 (e.g. 670000000)',
  })
  phone!: string;
}
