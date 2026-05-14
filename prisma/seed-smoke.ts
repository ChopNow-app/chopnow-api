/**
 * Seed the minimum data needed for a local smoke test.
 *
 * Creates (idempotent):
 *   - 1 active VENDOR (Chez Maman Smoke @ Makepe, isOpen=true) + 3 menu items
 *   - 1 active RIDER (Jean Smoke, MOTO, ONLINE @ Makepe)
 *
 * The consumer signs up via the normal OTP flow — in dev, the OTP is logged
 * to the server console (see OtpDeliveryService).
 *
 * Usage:
 *   npx ts-node prisma/seed-smoke.ts
 *
 * Re-running is safe — uses phone-based upsert so a second run doesn't
 * duplicate the rows.
 */
import {
  PrismaClient,
  UserRole,
  VendorType,
  VendorStatus,
  RiderVehicleType,
  RiderStatus,
} from '@prisma/client';

const MAKEPE = { lat: 4.0744, lng: 9.7565 };

// AuthService.normalizePhone converts the 9-digit Cameroon format to E.164 on
// signup, so the User row's `phone` column is always the +237 form. Seed in
// the same format so smoke-test signups find the existing row (otherwise
// verify-otp creates a fresh CONSUMER duplicate).
const VENDOR_PHONE = '+237670000091';
const RIDER_PHONE = '+237670000092';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // ── Vendor ────────────────────────────────────────────────────────
    const vendorUser = await prisma.user.upsert({
      where: { phone: VENDOR_PHONE },
      update: { isActive: true, role: UserRole.VENDOR },
      create: { phone: VENDOR_PHONE, role: UserRole.VENDOR, displayName: 'Maman Smoke' },
    });

    const existingVendor = await prisma.vendor.findUnique({ where: { userId: vendorUser.id } });
    let vendorId: string;
    if (!existingVendor) {
      // PostGIS POINT — must be set via raw query because Prisma can't write
      // Unsupported(geography). We create with a placeholder ST_MakePoint then
      // overwrite — actually we can use $executeRaw to insert directly.
      const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO vendors (
          id, "userId", name, description, type, status,
          quartier, "pointOfReference", location,
          "whatsappPhone", "momoPhone", "isOpen", "declaredCapacity",
          "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid(), ${vendorUser.id}, 'Chez Maman Smoke',
          'Cuisine locale Camerounaise — smoke-test seed.',
          ${VendorType.INFORMAL}::"VendorType", ${VendorStatus.ACTIVE}::"VendorStatus",
          'Makepe', 'En face de la pharmacie Ste-Marie',
          ST_SetSRID(ST_MakePoint(${MAKEPE.lng}, ${MAKEPE.lat}), 4326)::geography,
          '670000091', '670000091', TRUE, 30,
          NOW(), NOW()
        )
        RETURNING id
      `;
      vendorId = inserted[0].id;
      console.log(`Created vendor ${vendorId}`);
    } else {
      vendorId = existingVendor.id;
      await prisma.$executeRaw`
        UPDATE vendors
        SET "isOpen" = TRUE,
            status = ${VendorStatus.ACTIVE}::"VendorStatus",
            location = ST_SetSRID(ST_MakePoint(${MAKEPE.lng}, ${MAKEPE.lat}), 4326)::geography
        WHERE id = ${vendorId}
      `;
      console.log(`Updated vendor ${vendorId} → ACTIVE + isOpen`);
    }

    // Menu items — idempotent by (vendorId, name)
    const items = [
      { name: 'Poulet DG', description: 'Poulet rôti, plantains, légumes', priceXAF: 3000 },
      {
        name: 'Ndolè + viande',
        description: 'Plat traditionnel — feuilles + boeuf',
        priceXAF: 2500,
      },
      {
        name: 'Bobolo + sauce arachide',
        description: 'Manioc fermenté, sauce maison',
        priceXAF: 1500,
      },
    ];
    for (const it of items) {
      const existing = await prisma.item.findFirst({
        where: { vendorId, name: it.name },
        select: { id: true },
      });
      if (!existing) {
        await prisma.item.create({
          data: {
            vendorId,
            name: it.name,
            description: it.description,
            priceXAF: it.priceXAF,
            isAvailable: true,
            isInStock: true,
          },
        });
        console.log(`Created item "${it.name}"`);
      }
    }

    // ── Rider ─────────────────────────────────────────────────────────
    const riderUser = await prisma.user.upsert({
      where: { phone: RIDER_PHONE },
      update: { isActive: true, role: UserRole.RIDER },
      create: { phone: RIDER_PHONE, role: UserRole.RIDER, displayName: 'Jean Smoke' },
    });

    const existingRider = await prisma.rider.findUnique({ where: { userId: riderUser.id } });
    if (!existingRider) {
      await prisma.$executeRaw`
        INSERT INTO riders (
          id, "userId", "vehicleType", "licensePlate",
          "preferredZone", "momoPhone", status, "isOnline",
          "lastLocation", "lastSeenAt",
          "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid(), ${riderUser.id},
          ${RiderVehicleType.MOTO}::"RiderVehicleType", 'LT9999',
          'Makepe', '670000092',
          ${RiderStatus.ACTIVE}::"RiderStatus", TRUE,
          ST_SetSRID(ST_MakePoint(${MAKEPE.lng}, ${MAKEPE.lat}), 4326)::geography,
          NOW(), NOW(), NOW()
        )
      `;
      console.log(`Created rider for user ${riderUser.id}`);
    } else {
      await prisma.$executeRaw`
        UPDATE riders
        SET status = ${RiderStatus.ACTIVE}::"RiderStatus",
            "isOnline" = TRUE,
            "lastLocation" = ST_SetSRID(ST_MakePoint(${MAKEPE.lng}, ${MAKEPE.lat}), 4326)::geography,
            "lastSeenAt" = NOW()
        WHERE id = ${existingRider.id}
      `;
      console.log(`Updated rider ${existingRider.id} → ACTIVE + ONLINE`);
    }

    console.log('\n✅ Smoke seed complete.');
    console.log('\nNext steps:');
    console.log('  1. Start the consumer PWA and sign up with any new phone (e.g. 670000099).');
    console.log('  2. Check the API console for the OTP code.');
    console.log('  3. Browse /restaurants — "Chez Maman Smoke" should appear in plan 1.');
    console.log('  4. To act as the vendor: sign in with phone 670000091 (OTP in console).');
    console.log('  5. To act as the rider: sign in with phone 670000092 (OTP in console).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
