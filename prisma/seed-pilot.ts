/**
 * Seed the Week-1 micro-zone pilot data: 3 vendors + 3 riders in one
 * Douala neighborhood. Idempotent — re-run safely after editing names.
 *
 * BEFORE FIRST RUN, edit the constants below:
 *   - PILOT_ZONE: change `name` + `center` to the actual zone (e.g. Akwa,
 *     Bonapriso). The (lng, lat) drives PostGIS distance ranking; aim for
 *     a coordinate dead-center in the 1-2 km micro-zone.
 *   - VENDORS: replace each entry with the real restaurant name, owner
 *     phone (E.164), and one-line cuisine description.
 *   - RIDERS: replace each entry with the real rider name + phone.
 *   - Menu items per vendor are placeholders too — swap with real prices
 *     once you've onboarded the restaurant.
 *
 * Usage (locally with chopnow-api stack up):
 *   npx ts-node prisma/seed-pilot.ts
 *
 * Or via docker on the droplet:
 *   docker exec -w /app chopnow-staging-api node prisma/seed-pilot.js
 *   (compile first: npx tsc prisma/seed-pilot.ts → docker cp into container)
 */
import {
  PrismaClient,
  UserRole,
  VendorType,
  VendorStatus,
  RiderVehicleType,
  RiderStatus,
} from '@prisma/client';

// ─── PILOT ZONE (EDIT ME) ───────────────────────────────────────────────
// Default placeholder is Bonamoussadi, Douala — change to whichever
// neighborhood you decide on. Use Google Maps right-click → coordinates to
// get the exact (lat, lng) of the zone's center.
const PILOT_ZONE = {
  name: 'Bonamoussadi', // displayed as the vendor.quartier
  center: { lat: 4.0962, lng: 9.7385 },
};

// Badge copy must mirror VendorService.submitInformal — same map, kept
// here so the seed isn't a special case relative to the onboarding form.
const BADGE_FOR_TYPE: Record<VendorType, string> = {
  [VendorType.INFORMAL]: 'Cuisine locale 🍲',
  [VendorType.SEMI_FORMAL]: 'Maquis 🍽️',
  [VendorType.RESTAURANT]: 'Restaurant 🍽️',
};

// ─── VENDORS (EDIT ME) ──────────────────────────────────────────────────
// Replace name + phone (E.164, +237...) + description per restaurant.
// Phone must be unique across users; pick the owner's real WhatsApp number.
//
// `latOffset` / `lngOffset` (degrees from PILOT_ZONE.center) spread the
// 3 vendors across the micro-zone so PostGIS distance ranking is
// meaningful for catalogue testing. Each ~0.001° ≈ 110m at the equator.
// `type` varies across INFORMAL / SEMI_FORMAL / RESTAURANT so the badge
// + the new /vendre type selector both have realistic test data.
const VENDORS: Array<{
  ownerPhone: string;
  ownerName: string;
  restaurantName: string;
  description: string;
  type: VendorType;
  latOffset: number;
  lngOffset: number;
  whatsappPhone: string;
  momoPhone: string;
  pointOfReference: string;
  items: Array<{ name: string; description: string; priceXAF: number }>;
}> = [
  {
    ownerPhone: '+237670000101',
    ownerName: 'Maman Mboué',
    restaurantName: 'Chez Maman Mboué — PLACEHOLDER',
    description: 'Cuisine maison camerounaise — Ndolè, Poulet DG, Soya',
    type: VendorType.INFORMAL,
    latOffset: 0,
    lngOffset: 0,
    whatsappPhone: '670000101',
    momoPhone: '670000101',
    pointOfReference: 'Bonamoussadi — point de repère placeholder',
    items: [
      { name: 'Poulet DG', description: 'Poulet, plantains', priceXAF: 3000 },
      { name: 'Ndolè', description: 'Feuilles + viande', priceXAF: 2500 },
      { name: 'Soya', description: 'Brochette grillée', priceXAF: 1500 },
    ],
  },
  {
    ownerPhone: '+237670000102',
    ownerName: 'Jean Atangana',
    restaurantName: 'Maquis du Carrefour — PLACEHOLDER',
    description: 'Maquis populaire — sandwiches, riz sauté, brochettes',
    type: VendorType.SEMI_FORMAL,
    latOffset: 0.0018, // ~200m north
    lngOffset: 0.001, // ~110m east
    whatsappPhone: '670000102',
    momoPhone: '670000102',
    pointOfReference: 'Carrefour Total Bonamoussadi',
    items: [
      { name: 'Sandwich poulet', description: 'Baguette + poulet', priceXAF: 1500 },
      { name: 'Riz sauté', description: 'Riz + légumes + viande', priceXAF: 2000 },
    ],
  },
  {
    ownerPhone: '+237670000103',
    ownerName: 'Restaurant Le Repère',
    restaurantName: 'Restaurant Le Repère — PLACEHOLDER',
    description: 'Cuisine traditionnelle — Eru, Koki, plats du jour',
    type: VendorType.RESTAURANT,
    latOffset: -0.0012, // ~130m south
    lngOffset: -0.0015, // ~165m west
    whatsappPhone: '670000103',
    momoPhone: '670000103',
    pointOfReference: 'Face à la pharmacie de Bonamoussadi',
    items: [
      { name: 'Eru', description: "Feuilles d'eru + waterfufu", priceXAF: 2000 },
      { name: 'Koki', description: 'Pâté de haricots vapeur', priceXAF: 1200 },
    ],
  },
];

// ─── RIDERS (EDIT ME) ───────────────────────────────────────────────────
const RIDERS: Array<{
  phone: string;
  displayName: string;
  vehicleType: RiderVehicleType;
  licensePlate: string;
  momoPhone: string;
}> = [
  {
    phone: '+237670000201',
    displayName: 'Livreur 1 — PLACEHOLDER',
    vehicleType: RiderVehicleType.MOTO,
    licensePlate: 'LT0001',
    momoPhone: '670000201',
  },
  {
    phone: '+237670000202',
    displayName: 'Livreur 2 — PLACEHOLDER',
    vehicleType: RiderVehicleType.MOTO,
    licensePlate: 'LT0002',
    momoPhone: '670000202',
  },
  {
    phone: '+237670000203',
    displayName: 'Livreur 3 — PLACEHOLDER',
    vehicleType: RiderVehicleType.MOTO,
    licensePlate: 'LT0003',
    momoPhone: '670000203',
  },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    console.log(`Seeding pilot data for zone: ${PILOT_ZONE.name}`);
    console.log(`Zone center: (${PILOT_ZONE.center.lat}, ${PILOT_ZONE.center.lng})`);

    for (const v of VENDORS) {
      const user = await prisma.user.upsert({
        where: { phone: v.ownerPhone },
        update: { isActive: true, role: UserRole.VENDOR, displayName: v.ownerName },
        create: { phone: v.ownerPhone, role: UserRole.VENDOR, displayName: v.ownerName },
      });

      const vendorLat = PILOT_ZONE.center.lat + v.latOffset;
      const vendorLng = PILOT_ZONE.center.lng + v.lngOffset;
      const badge = BADGE_FOR_TYPE[v.type];

      const existing = await prisma.vendor.findUnique({ where: { userId: user.id } });
      let vendorId: string;
      if (!existing) {
        const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
          INSERT INTO vendors (
            id, "userId", name, "ownerName", description, type, status,
            quartier, "pointOfReference", location, badge,
            "whatsappPhone", "momoPhone", "isOpen", "declaredCapacity",
            "createdAt", "updatedAt"
          ) VALUES (
            gen_random_uuid(), ${user.id}, ${v.restaurantName}, ${v.ownerName},
            ${v.description},
            ${v.type}::"VendorType", ${VendorStatus.ACTIVE}::"VendorStatus",
            ${PILOT_ZONE.name}, ${v.pointOfReference},
            ST_SetSRID(ST_MakePoint(${vendorLng}, ${vendorLat}), 4326)::geography,
            ${badge},
            ${v.whatsappPhone}, ${v.momoPhone}, TRUE, 30,
            NOW(), NOW()
          )
          RETURNING id
        `;
        vendorId = inserted[0].id;
        console.log(`  + vendor "${v.restaurantName}" (${vendorId}) [${v.type}]`);
      } else {
        vendorId = existing.id;
        await prisma.$executeRaw`
          UPDATE vendors
          SET name = ${v.restaurantName},
              "ownerName" = ${v.ownerName},
              description = ${v.description},
              type = ${v.type}::"VendorType",
              badge = ${badge},
              "isOpen" = TRUE,
              status = ${VendorStatus.ACTIVE}::"VendorStatus",
              quartier = ${PILOT_ZONE.name},
              location = ST_SetSRID(ST_MakePoint(${vendorLng}, ${vendorLat}), 4326)::geography
          WHERE id = ${vendorId}
        `;
        console.log(`  ~ vendor "${v.restaurantName}" updated [${v.type}]`);
      }

      for (const it of v.items) {
        const item = await prisma.item.findFirst({
          where: { vendorId, name: it.name },
          select: { id: true },
        });
        if (!item) {
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
        }
      }
    }

    for (const r of RIDERS) {
      const user = await prisma.user.upsert({
        where: { phone: r.phone },
        update: { isActive: true, role: UserRole.RIDER, displayName: r.displayName },
        create: { phone: r.phone, role: UserRole.RIDER, displayName: r.displayName },
      });

      const existing = await prisma.rider.findUnique({ where: { userId: user.id } });
      if (!existing) {
        await prisma.$executeRaw`
          INSERT INTO riders (
            id, "userId", "vehicleType", "licensePlate",
            "preferredZone", "momoPhone", status, "isOnline",
            "lastLocation", "lastSeenAt",
            "createdAt", "updatedAt"
          ) VALUES (
            gen_random_uuid(), ${user.id},
            ${r.vehicleType}::"RiderVehicleType", ${r.licensePlate},
            ${PILOT_ZONE.name}, ${r.momoPhone},
            ${RiderStatus.ACTIVE}::"RiderStatus", FALSE,
            ST_SetSRID(ST_MakePoint(${PILOT_ZONE.center.lng}, ${PILOT_ZONE.center.lat}), 4326)::geography,
            NOW(), NOW(), NOW()
          )
        `;
        console.log(`  + rider "${r.displayName}"`);
      } else {
        await prisma.$executeRaw`
          UPDATE riders
          SET "preferredZone" = ${PILOT_ZONE.name},
              status = ${RiderStatus.ACTIVE}::"RiderStatus"
          WHERE id = ${existing.id}
        `;
        console.log(`  ~ rider "${r.displayName}" updated`);
      }
    }

    console.log('Pilot seed complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
