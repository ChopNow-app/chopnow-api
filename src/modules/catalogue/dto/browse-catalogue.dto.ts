import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/** Story 2.5 — query params for `GET /catalogue`. */
export class BrowseCatalogueDto {
  @ApiProperty({ description: 'Consumer latitude.', example: 4.0511 })
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ description: 'Consumer longitude.', example: 9.7679 })
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @ApiProperty({
    description:
      'Max distance to fetch in km. Defaults to 10 (covers Douala metro). ' +
      'Catalogue groups results into 3 plans (≤2km, ≤5km, >5km) regardless.',
    required: false,
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(50)
  radiusKm?: number;
}
