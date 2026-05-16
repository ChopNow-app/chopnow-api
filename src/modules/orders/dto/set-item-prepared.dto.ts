import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Toggle a single OrderItem's prepared flag from the vendor preparation
 * screen. `true` stamps preparedAt = now; `false` clears it. The service
 * decides whether the order's status flips ACCEPTED ↔ IN_PREP as a
 * side-effect based on the post-update aggregate.
 */
export class SetItemPreparedDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  prepared!: boolean;
}
