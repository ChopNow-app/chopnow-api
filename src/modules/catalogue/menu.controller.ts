import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseFilePipeBuilder,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UpsertItemDto, UpdateItemStockDto } from './dto/item.dto';
import { UpsertCategoryDto } from './dto/menu-category.dto';
import { MenuService } from './menu.service';

// Same envelope as vendor onboarding photos — keeps Android Chrome captures
// well under the limit while rejecting raw DSLR shots / mis-resized originals.
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const imagePipe = new ParseFilePipeBuilder()
  .addFileTypeValidator({ fileType: /image\/(jpe?g|png|webp|heic|heif)/ })
  .addMaxSizeValidator({ maxSize: MAX_PHOTO_BYTES })
  .build({ fileIsRequired: true });

@ApiTags('vendor-menu')
@ApiBearerAuth()
@Roles(UserRole.VENDOR)
@Controller('vendors/me')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  // ── items ──────────────────────────────────────────────────────────

  @Get('items')
  @ApiOperation({ summary: 'List own menu items (Story 2.2 / 2.3)' })
  listItems(@Req() req: Request) {
    return this.menu.listItems((req.user as { id: string }).id);
  }

  @Post('items')
  @ApiOperation({
    summary: 'Create a menu item (Story 2.2 / 2.3)',
    description:
      'Informal vendors capped at 15 items / 2 categories. Restaurants unlimited. ' +
      'Conflict codes: menu_limit_reached, category_not_yours, category_not_found.',
  })
  createItem(@Req() req: Request, @Body() dto: UpsertItemDto) {
    return this.menu.createItem((req.user as { id: string }).id, dto);
  }

  @Put('items/:itemId')
  @ApiOperation({ summary: 'Replace a menu item' })
  updateItem(
    @Req() req: Request,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: UpsertItemDto,
  ) {
    return this.menu.updateItem((req.user as { id: string }).id, itemId, dto);
  }

  @Delete('items/:itemId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a menu item' })
  deleteItem(@Req() req: Request, @Param('itemId', new ParseUUIDPipe()) itemId: string) {
    return this.menu.deleteItem((req.user as { id: string }).id, itemId);
  }

  @Patch('items/:itemId/stock')
  @ApiOperation({
    summary: '1-tap stock toggle (Story 2.10)',
    description:
      'Lightweight endpoint specifically for the dashboard "Disponible / Épuisé" switch. ' +
      'Designed to take a Tecno/Itel 1-tap on 3G without blocking on payload size.',
  })
  setStock(
    @Req() req: Request,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: UpdateItemStockDto,
  ) {
    return this.menu.setItemStock((req.user as { id: string }).id, itemId, dto);
  }

  @Patch('items/:itemId/photo')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_BYTES } }))
  @ApiOperation({ summary: 'Upload / replace an item photo' })
  async setPhoto(
    @Req() req: Request,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @UploadedFile() photo: Express.Multer.File,
  ) {
    if (!photo) throw new BadRequestException('photo is required');
    await imagePipe.transform(photo);
    return this.menu.setItemPhoto((req.user as { id: string }).id, itemId, photo);
  }

  // ── categories ────────────────────────────────────────────────────

  @Get('categories')
  @ApiOperation({ summary: 'List own menu categories' })
  listCategories(@Req() req: Request) {
    return this.menu.listCategories((req.user as { id: string }).id);
  }

  @Post('categories')
  @ApiOperation({
    summary: 'Create a menu category (Story 2.3)',
    description:
      'Informal vendors capped at 2 categories. Conflict codes: category_limit_reached, category_name_taken.',
  })
  createCategory(@Req() req: Request, @Body() dto: UpsertCategoryDto) {
    return this.menu.createCategory((req.user as { id: string }).id, dto);
  }

  @Patch('categories/:categoryId')
  @ApiOperation({ summary: 'Rename / reorder a category' })
  updateCategory(
    @Req() req: Request,
    @Param('categoryId', new ParseUUIDPipe()) categoryId: string,
    @Body() dto: UpsertCategoryDto,
  ) {
    return this.menu.updateCategory((req.user as { id: string }).id, categoryId, dto);
  }

  @Delete('categories/:categoryId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a category. Items in it are detached (categoryId = NULL).' })
  deleteCategory(
    @Req() req: Request,
    @Param('categoryId', new ParseUUIDPipe()) categoryId: string,
  ) {
    return this.menu.deleteCategory((req.user as { id: string }).id, categoryId);
  }
}
