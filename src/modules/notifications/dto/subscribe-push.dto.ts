import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsObject, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

class PushKeysDto {
  @ApiProperty({ description: 'P-256 ECDH public key (base64url)' })
  @IsString()
  @MinLength(10)
  @MaxLength(256)
  p256dh!: string;

  @ApiProperty({ description: 'Auth secret (base64url)' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  auth!: string;
}

export class SubscribePushDto {
  @ApiProperty({ description: 'Push service endpoint URL (FCM/APNs/Mozilla)' })
  @IsString()
  @MaxLength(2048)
  endpoint!: string;

  // @ValidateNested + @Type are required for class-validator to actually
  // descend into PushKeysDto. Without them, @IsObject() lets through any
  // non-null object — including `{}` or `{ foo: 'bar' }` — and the missing
  // p256dh/auth would only fail downstream in WebPushService (500 instead
  // of a clean 400 at the boundary).
  @ApiProperty({ type: PushKeysDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;

  @ApiProperty({
    description:
      'Opaque per-device ID minted by the client (localStorage) so re-subscribes from the same device dedupe',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  deviceFingerprint!: string;
}

export class UnsubscribePushDto {
  @ApiProperty({ description: 'Push service endpoint URL to deactivate' })
  @IsString()
  @MaxLength(2048)
  endpoint!: string;
}
