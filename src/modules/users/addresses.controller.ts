import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AddressesService } from './addresses.service';
import { UpsertAddressDto } from './dto/upsert-address.dto';

@ApiTags('addresses')
@ApiBearerAuth()
@Controller('users/me/addresses')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  @ApiOperation({ summary: 'List saved addresses (Story 3.2)' })
  list(@Req() req: Request) {
    return this.addresses.list((req.user as { id: string }).id);
  }

  @Post()
  @ApiOperation({
    summary: 'Save a new address (max 3 per user)',
    description:
      'Conflict code: address_limit_reached. Setting isDefault demotes any existing default.',
  })
  create(@Req() req: Request, @Body() dto: UpsertAddressDto) {
    return this.addresses.create((req.user as { id: string }).id, dto);
  }

  @Put(':addressId')
  @ApiOperation({ summary: 'Replace an address (ownership-checked)' })
  update(
    @Req() req: Request,
    @Param('addressId', new ParseUUIDPipe()) addressId: string,
    @Body() dto: UpsertAddressDto,
  ) {
    return this.addresses.update((req.user as { id: string }).id, addressId, dto);
  }

  @Delete(':addressId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete an address' })
  delete(@Req() req: Request, @Param('addressId', new ParseUUIDPipe()) addressId: string) {
    return this.addresses.delete((req.user as { id: string }).id, addressId);
  }
}
