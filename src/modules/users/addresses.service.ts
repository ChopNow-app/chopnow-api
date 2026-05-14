import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { normalizePhone } from '../../shared/phone/phone.util';
import { UpsertAddressDto } from './dto/upsert-address.dto';

// Story 3.2 — max 3 saved addresses per consumer (spec).
const MAX_SAVED_ADDRESSES = 3;

interface AddressRow {
  id: string;
  user_id: string;
  label: string | null;
  description: string | null;
  quartier: string | null;
  landmark_id: string | null;
  lat: number;
  lng: number;
  phone: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AddressView {
  id: string;
  label: string | null;
  description: string | null;
  quartier: string | null;
  landmarkId: string | null;
  lat: number;
  lng: number;
  phone: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Address CRUD — location is `Unsupported(geography)` so all reads/writes go through raw SQL. */
@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<AddressView[]> {
    const rows = await this.prisma.$queryRaw<AddressRow[]>`
      SELECT
        id,
        "userId"        AS user_id,
        label,
        description,
        quartier,
        "landmarkId"    AS landmark_id,
        ST_Y(location::geometry) AS lat,
        ST_X(location::geometry) AS lng,
        phone,
        "isDefault"     AS is_default,
        "createdAt"     AS created_at,
        "updatedAt"     AS updated_at
      FROM "addresses"
      WHERE "userId" = ${userId}
      ORDER BY "isDefault" DESC, "createdAt" DESC
    `;
    return rows.map(this.toView);
  }

  async create(userId: string, dto: UpsertAddressDto): Promise<AddressView> {
    const count = await this.prisma.address.count({ where: { userId } });
    if (count >= MAX_SAVED_ADDRESSES) {
      throw new ConflictException({
        code: 'address_limit_reached',
        message: `Maximum ${MAX_SAVED_ADDRESSES} saved addresses. Delete one before saving another.`,
      });
    }

    // If the new address claims default, demote any existing default first.
    if (dto.isDefault) {
      await this.prisma.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const id = await this.insertRaw(userId, dto, !!dto.isDefault);
    return (await this.list(userId)).find((a) => a.id === id)!;
  }

  async update(userId: string, addressId: string, dto: UpsertAddressDto): Promise<AddressView> {
    const existing = await this.prisma.address.findUnique({ where: { id: addressId } });
    if (!existing) throw new NotFoundException('address_not_found');
    if (existing.userId !== userId) throw new ForbiddenException('address_not_yours');

    if (dto.isDefault) {
      // Demote everyone else first (single SET fires; idempotent).
      await this.prisma.address.updateMany({
        where: { userId, isDefault: true, id: { not: addressId } },
        data: { isDefault: false },
      });
    }

    await this.prisma.$executeRaw`
      UPDATE "addresses"
      SET label            = ${dto.label ?? null},
          description      = ${dto.description ?? null},
          quartier         = ${dto.quartier ?? null},
          "landmarkId"     = ${dto.landmarkId ?? null},
          location         = ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography,
          phone            = ${dto.phone ? normalizePhone(dto.phone) : null},
          "isDefault"      = ${dto.isDefault ?? false},
          "updatedAt"      = NOW()
      WHERE id = ${addressId}
    `;
    return (await this.list(userId)).find((a) => a.id === addressId)!;
  }

  async delete(userId: string, addressId: string): Promise<{ ok: true }> {
    const existing = await this.prisma.address.findUnique({ where: { id: addressId } });
    if (!existing) throw new NotFoundException('address_not_found');
    if (existing.userId !== userId) throw new ForbiddenException('address_not_yours');

    await this.prisma.address.delete({ where: { id: addressId } });
    return { ok: true as const };
  }

  // ── private ──────────────────────────────────────────────────────

  private async insertRaw(
    userId: string,
    dto: UpsertAddressDto,
    isDefault: boolean,
  ): Promise<string> {
    // Generate the id in SQL so we can return it via RETURNING-style without
    // doing a follow-up SELECT — though Prisma's $queryRaw lets us pick it up
    // either way.
    const id = randomUUID();
    await this.prisma.$executeRaw`
      INSERT INTO "addresses" (
        id, "userId", label, description, quartier, "landmarkId",
        location, phone, "isDefault", "createdAt", "updatedAt"
      ) VALUES (
        ${id},
        ${userId},
        ${dto.label ?? null},
        ${dto.description ?? null},
        ${dto.quartier ?? null},
        ${dto.landmarkId ?? null},
        ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography,
        ${dto.phone ? normalizePhone(dto.phone) : null},
        ${isDefault},
        NOW(), NOW()
      )
    `;
    return id;
  }

  private toView(row: AddressRow): AddressView {
    return {
      id: row.id,
      label: row.label,
      description: row.description,
      quartier: row.quartier,
      landmarkId: row.landmark_id,
      lat: row.lat,
      lng: row.lng,
      phone: row.phone,
      isDefault: row.is_default,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
