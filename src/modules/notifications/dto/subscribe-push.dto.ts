import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsString, MaxLength, MinLength } from 'class-validator';

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

  @ApiProperty({ type: PushKeysDto })
  @IsObject()
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
