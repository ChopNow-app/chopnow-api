import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ItemKind, StockLevel } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
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

  @ApiProperty({
    required: false,
    enum: ItemKind,
    default: ItemKind.FOOD,
    description: 'Food/Drink — drives the /vendor/menu category tabs.',
  })
  @IsOptional()
  @IsEnum(ItemKind)
  kind?: ItemKind;

  @ApiProperty({
    required: false,
    enum: StockLevel,
    default: StockLevel.IN_STOCK,
    description:
      'Stock state. Defaults to IN_STOCK on create. Edit later from the menu screen / item editor.',
  })
  @IsOptional()
  @IsEnum(StockLevel)
  stockLevel?: StockLevel;
}

/** Story 2.10 — stock toggle, now 3-tier. The legacy boolean payload is
 * accepted as a fallback so callers that haven't upgraded keep working
 * (true → IN_STOCK, false → OUT_OF_STOCK). New callers send `stockLevel`. */
export class UpdateItemStockDto {
  @ApiProperty({
    example: false,
    required: false,
    description: 'Legacy fallback — true = IN_STOCK, false = OUT_OF_STOCK.',
  })
  @IsOptional()
  @IsBoolean()
  isInStock?: boolean;

  @ApiProperty({
    required: false,
    enum: StockLevel,
    description: 'Preferred — full 3-tier stock control.',
  })
  @IsOptional()
  @IsEnum(StockLevel)
  stockLevel?: StockLevel;
}
