import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Story 2.2 / 2.3 — create or update a menu item. */
export class UpsertItemDto {
  @ApiProperty({ example: 'Poulet DG' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ required: false, example: 'Poulet rôti, plantains, légumes du jour.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: 3000, description: 'Prix entier FCFA (>= 100).' })
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(1_000_000)
  priceXAF!: number;

  @ApiProperty({ required: false, description: "UUID d'une MenuCategory du même vendeur." })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    required: false,
    description: 'Temps de préparation moyen (minutes). Restaurants uniquement.',
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(180)
  preparationMinutes?: number;

  @ApiProperty({ required: false, description: "Ordre d'affichage. Lower = first.", example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** Story 2.10 — 1-tap stock toggle. */
export class UpdateItemStockDto {
  @ApiProperty({ example: false, description: 'true = Disponible, false = Épuisé.' })
  @IsBoolean()
  isInStock!: boolean;
}
