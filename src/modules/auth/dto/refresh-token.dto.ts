import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'Refresh JWT obtained from /auth/verify-otp or a prior /auth/refresh call.',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
