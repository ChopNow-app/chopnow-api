import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../shared/decorators/public.decorator';
import { BrowseService } from './browse.service';
import { BrowseCatalogueDto } from './dto/browse-catalogue.dto';

@ApiTags('catalogue')
@Controller()
export class BrowseController {
  constructor(private readonly browse: BrowseService) {}

  // Public: consumers browse anonymously before signing up.
  @Public()
  @Get('catalogue')
  @ApiOperation({
    summary: 'Browse vendors near a location (Story 2.5)',
    description:
      'Returns ACTIVE + isOpen vendors within radius (default 10km) ranked by distance. ' +
      'Each card carries server-computed distanceKm, deliveryFeeXAF, etaMinutes, and a plan tier ' +
      '(1 = ≤2km, 2 = ≤5km, 3 = >5km) so the consumer PWA can render the three sections without ' +
      'reimplementing geo math.',
  })
  catalogue(@Query() query: BrowseCatalogueDto) {
    return this.browse.browse(query);
  }

  // Public: the share link from "Bouton Partager" lands here too.
  @Public()
  @Get('vendors/:vendorId')
  @ApiOperation({
    summary: 'Vendor public profile + menu (Story 2.6)',
    description:
      'Returns vendor header, categories, and in-stock items. 404 if vendor is not ACTIVE.',
  })
  vendorPublic(@Param('vendorId', new ParseUUIDPipe()) vendorId: string) {
    return this.browse.getVendorPublic(vendorId);
  }
}
