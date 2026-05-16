import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockLevel, VendorType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { R2Service } from '../../infra/r2/r2.service';
import { UpsertItemDto, UpdateItemStockDto } from './dto/item.dto';
import { UpsertCategoryDto } from './dto/menu-category.dto';

// Story 2.2 — informal vendors are capped at 15 items / 2 categories
// (deliberate simplicity for cuisinières who only have a phone). Restaurants
// have no cap — they manage structured menus with full category tree.
const INFORMAL_MAX_ITEMS = 15;
const INFORMAL_MAX_CATEGORIES = 2;

const ITEM_SELECT = {
  id: true,
  vendorId: true,
  categoryId: true,
  name: true,
  description: true,
  priceXAF: true,
  photoUrl: true,
  isAvailable: true,
  isInStock: true,
  stockLevel: true,
  kind: true,
  preparationMinutes: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ItemSelect;

const CATEGORY_SELECT = {
  id: true,
  vendorId: true,
  name: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MenuCategorySelect;

/** Vendor menu management — items + categories (Stories 2.2, 2.3, 2.10). */
@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
  ) {}

  // ── items ──────────────────────────────────────────────────────────

  async listItems(userId: string) {
    const vendor = await this.requireVendor(userId);
    return this.prisma.item.findMany({
      where: { vendorId: vendor.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: ITEM_SELECT,
    });
  }

  async createItem(userId: string, dto: UpsertItemDto) {
    const vendor = await this.requireVendor(userId);

    if (vendor.type === VendorType.INFORMAL) {
      const count = await this.prisma.item.count({ where: { vendorId: vendor.id } });
      if (count >= INFORMAL_MAX_ITEMS) {
        throw new ConflictException({
          code: 'menu_limit_reached',
          message: `Informal vendors are capped at ${INFORMAL_MAX_ITEMS} items. Delete an existing item before adding a new one.`,
        });
      }
    }

    if (dto.categoryId) {
      await this.requireCategoryBelongsTo(vendor.id, dto.categoryId);
    }

    const stockLevel = dto.stockLevel ?? StockLevel.IN_STOCK;
    return this.prisma.item.create({
      data: {
        vendorId: vendor.id,
        name: dto.name,
        description: dto.description ?? null,
        priceXAF: dto.priceXAF,
        categoryId: dto.categoryId ?? null,
        preparationMinutes: dto.preparationMinutes ?? null,
        sortOrder: dto.sortOrder ?? 0,
        kind: dto.kind ?? undefined, // schema default = FOOD
        isAvailable: true,
        isInStock: stockLevel !== StockLevel.OUT_OF_STOCK,
        stockLevel,
      },
      select: ITEM_SELECT,
    });
  }

  async updateItem(userId: string, itemId: string, dto: UpsertItemDto) {
    const vendor = await this.requireVendor(userId);
    await this.requireItemBelongsTo(vendor.id, itemId);
    if (dto.categoryId) {
      await this.requireCategoryBelongsTo(vendor.id, dto.categoryId);
    }

    // When stockLevel is omitted, leave the existing value alone — the
    // 1-tap toggle endpoint is the dedicated way to flip it (and the menu
    // editor will send stockLevel explicitly when it wants to change it).
    const stockUpdate =
      dto.stockLevel !== undefined
        ? { stockLevel: dto.stockLevel, isInStock: dto.stockLevel !== StockLevel.OUT_OF_STOCK }
        : {};

    return this.prisma.item.update({
      where: { id: itemId },
      data: {
        name: dto.name,
        description: dto.description ?? null,
        priceXAF: dto.priceXAF,
        categoryId: dto.categoryId ?? null,
        preparationMinutes: dto.preparationMinutes ?? null,
        sortOrder: dto.sortOrder ?? undefined,
        kind: dto.kind ?? undefined,
        ...stockUpdate,
      },
      select: ITEM_SELECT,
    });
  }

  async deleteItem(userId: string, itemId: string) {
    const vendor = await this.requireVendor(userId);
    await this.requireItemBelongsTo(vendor.id, itemId);
    await this.prisma.item.delete({ where: { id: itemId } });
    return { ok: true as const };
  }

  /** Story 2.10 — 1-tap stock toggle. Accepts either the legacy boolean or
   *  the new 3-tier `stockLevel`. Keeps the two fields consistent so the
   *  consumer catalogue (`isInStock=true`) and the vendor menu screen
   *  (`stockLevel=LOW_STOCK`) can't disagree about whether an item is sellable. */
  async setItemStock(userId: string, itemId: string, dto: UpdateItemStockDto) {
    const vendor = await this.requireVendor(userId);
    await this.requireItemBelongsTo(vendor.id, itemId);

    const stockLevel: StockLevel =
      dto.stockLevel ??
      (dto.isInStock === true
        ? StockLevel.IN_STOCK
        : dto.isInStock === false
          ? StockLevel.OUT_OF_STOCK
          : StockLevel.IN_STOCK); // neither field present — fall back to IN_STOCK

    return this.prisma.item.update({
      where: { id: itemId },
      data: {
        stockLevel,
        isInStock: stockLevel !== StockLevel.OUT_OF_STOCK,
      },
      select: ITEM_SELECT,
    });
  }

  async setItemPhoto(userId: string, itemId: string, file: Express.Multer.File) {
    const vendor = await this.requireVendor(userId);
    await this.requireItemBelongsTo(vendor.id, itemId);
    const upload = await this.r2.uploadImage(file.buffer, { keyPrefix: 'item-photo' });
    return this.prisma.item.update({
      where: { id: itemId },
      data: { photoUrl: upload.key },
      select: ITEM_SELECT,
    });
  }

  // ── categories ────────────────────────────────────────────────────

  async listCategories(userId: string) {
    const vendor = await this.requireVendor(userId);
    return this.prisma.menuCategory.findMany({
      where: { vendorId: vendor.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: CATEGORY_SELECT,
    });
  }

  async createCategory(userId: string, dto: UpsertCategoryDto) {
    const vendor = await this.requireVendor(userId);

    if (vendor.type === VendorType.INFORMAL) {
      const count = await this.prisma.menuCategory.count({ where: { vendorId: vendor.id } });
      if (count >= INFORMAL_MAX_CATEGORIES) {
        throw new ConflictException({
          code: 'category_limit_reached',
          message: `Informal vendors are capped at ${INFORMAL_MAX_CATEGORIES} categories.`,
        });
      }
    }

    try {
      return await this.prisma.menuCategory.create({
        data: {
          vendorId: vendor.id,
          name: dto.name,
          sortOrder: dto.sortOrder ?? 0,
        },
        select: CATEGORY_SELECT,
      });
    } catch (err) {
      // @@unique([vendorId, name]) on MenuCategory — surface as structured 409.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'category_name_taken',
          message: 'A category with this name already exists for your menu.',
        });
      }
      throw err;
    }
  }

  async updateCategory(userId: string, categoryId: string, dto: UpsertCategoryDto) {
    const vendor = await this.requireVendor(userId);
    await this.requireCategoryBelongsTo(vendor.id, categoryId);
    try {
      return await this.prisma.menuCategory.update({
        where: { id: categoryId },
        data: { name: dto.name, sortOrder: dto.sortOrder ?? undefined },
        select: CATEGORY_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'category_name_taken',
          message: 'A category with this name already exists for your menu.',
        });
      }
      throw err;
    }
  }

  async deleteCategory(userId: string, categoryId: string) {
    const vendor = await this.requireVendor(userId);
    await this.requireCategoryBelongsTo(vendor.id, categoryId);
    // Items in this category have categoryId set to NULL by Prisma's onDelete: SetNull.
    await this.prisma.menuCategory.delete({ where: { id: categoryId } });
    return { ok: true as const };
  }

  // ── helpers ────────────────────────────────────────────────────────

  private async requireVendor(userId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, type: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');
    return vendor;
  }

  private async requireItemBelongsTo(vendorId: string, itemId: string) {
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { vendorId: true },
    });
    if (!item) throw new NotFoundException('item_not_found');
    // Ownership check is the security boundary — never let a vendor mutate
    // another vendor's items even if they happen to know the id.
    if (item.vendorId !== vendorId) throw new ForbiddenException('item_not_yours');
  }

  private async requireCategoryBelongsTo(vendorId: string, categoryId: string) {
    const cat = await this.prisma.menuCategory.findUnique({
      where: { id: categoryId },
      select: { vendorId: true },
    });
    if (!cat) throw new NotFoundException('category_not_found');
    if (cat.vendorId !== vendorId) throw new ForbiddenException('category_not_yours');
  }
}
