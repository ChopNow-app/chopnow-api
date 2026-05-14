import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsLatitude, IsLongitude } from 'class-validator';

/** Story 4.1 — 1-tap "Je commence" / "Pause" toggle. */
export class RiderAvailabilityDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  isOnline!: boolean;
}

/** Story 4.4 — 15s GPS heartbeat from the app. */
export class RiderHeartbeatDto {
  @ApiProperty({ example: 4.0511 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: 9.7679 })
  @Type(() => Number)
  @IsLongitude()
  lng!: number;
}
