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
import { randomUUID } from 'node:crypto';
import {
  PrismaClient,
  UserRole,
  VendorType,
  VendorStatus,
  RiderVehicleType,
  RiderStatus,
} from '@prisma/client';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';

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

// ─── DEMO PHOTO URLS ────────────────────────────────────────────────────
// Royalty-free Unsplash images used as placeholder vendor photos until
// real onboarding photos land via /vendre. Each is downloaded at seed
// time, re-encoded to WebP @ ≤1280px max-edge (same standard as the
// VendorService image pipeline), and uploaded to R2. The placeholder
// PLACEHOLDER suffix in vendor names is your visual reminder that the
// catalogue is not yet showing real pilot vendors.
const DEMO_PHOTOS = {
  // INFORMAL — cozy home kitchen / market stall
  informal: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=1280&q=80',
  // SEMI_FORMAL — small street-food / maquis exterior
  semiFormal: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=1280&q=80',
  // RESTAURANT — restaurant interior
  restaurant: 'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=1280&q=80',
};

const PHOTO_FOR_TYPE: Record<VendorType, string> = {
  [VendorType.INFORMAL]: DEMO_PHOTOS.informal,
  [VendorType.SEMI_FORMAL]: DEMO_PHOTOS.semiFormal,
  [VendorType.RESTAURANT]: DEMO_PHOTOS.restaurant,
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
  items: Array<{
    name: string;
    description: string;
    priceXAF: number;
    // Optional source URL — generic Unsplash food photo while waiting for
    // real vendor menu shots. Uploaded to R2 under `menu-items/seed-*.webp`
    // by the seed (idempotent: only fires when the DB row has no photoUrl).
    // To swap a photo, NULL the row's photoUrl column and re-run the seed.
    photoUrl?: string;
  }>;
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
      {
        name: 'Poulet DG',
        description: 'Poulet, plantains',
        priceXAF: 3000,
        photoUrl: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c6?w=1280&q=80',
      },
      {
        name: 'Ndolè',
        description: 'Feuilles + viande',
        priceXAF: 2500,
        photoUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=1280&q=80',
      },
      {
        name: 'Soya',
        description: 'Brochette grillée',
        priceXAF: 1500,
        photoUrl: 'https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?w=1280&q=80',
      },
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
      {
        name: 'Sandwich poulet',
        description: 'Baguette + poulet',
        priceXAF: 1500,
        photoUrl: 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=1280&q=80',
      },
      {
        name: 'Riz sauté',
        description: 'Riz + légumes + viande',
        priceXAF: 2000,
        photoUrl: 'https://images.unsplash.com/photo-1603133872878-684f208fb84b?w=1280&q=80',
      },
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
      {
        name: 'Eru',
        description: "Feuilles d'eru + waterfufu",
        priceXAF: 2000,
        // Generic stew bowl — the previous Unsplash ID (1604908554049-…)
        // 404'd in the 2026-05-23 seed run.
        photoUrl: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=1280&q=80',
      },
      {
        name: 'Koki',
        description: 'Pâté de haricots vapeur',
        priceXAF: 1200,
        photoUrl: 'https://images.unsplash.com/photo-1543353071-10c8ba85a904?w=1280&q=80',
      },
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

// Lazy-init R2 client — only spun up when we actually need to upload a
// seed photo. Reads the same env vars as the running API so the seed
// works wherever the API container does (local dev, staging droplet,
// future Hetzner prod). Throws clearly if the env isn't configured so
// the seed run fails fast rather than silently skipping photos.
function makeR2Client(): { client: S3Client; bucket: string } {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      'R2 env not configured — set R2_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + R2_BUCKET',
    );
  }
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return { client, bucket };
}

// Fetch an external image, re-encode to WebP @ ≤1280px (matching the
// R2Service.uploadImage pipeline used by /vendre + /livrer), upload to
// R2 under `<keyPrefix>/seed-<uuid>.webp`, and return the storage key.
// keyPrefix examples: 'vendor-profile', 'item-photo'.
async function downloadAndUploadPhoto(
  sourceUrl: string,
  r2: { client: S3Client; bucket: string },
  keyPrefix: 'vendor-profile' | 'item-photo' = 'vendor-profile',
  // Why 'item-photo' (not 'menu-items'): it matches the prefix used by
  // the production MenuService upload path, which is what the
  // MediaController's ALLOWED_PREFIXES allowlist accepts. The R2 proxy
  // 404s any other prefix.
): Promise<string> {
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch demo photo ${sourceUrl}: HTTP ${res.status}`);
  }
  const input = Buffer.from(await res.arrayBuffer());
  const optimized = await sharp(input)
    .rotate()
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  const key = `${keyPrefix}/seed-${randomUUID()}.webp`;
  await r2.client.send(
    new PutObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      Body: optimized,
      ContentType: 'image/webp',
    }),
  );
  return key;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const r2 = makeR2Client();
  try {
    console.log(`Seeding pilot data for zone: ${PILOT_ZONE.name}`);
    console.log(`Zone center: (${PILOT_ZONE.center.lat}, ${PILOT_ZONE.center.lng})`);

    // One-time migration: an earlier seed run (2026-05-23) wrote menu
    // photoUrls under `menu-items/seed-*` — a prefix the MediaController
    // doesn't allowlist, so every image returned 404. NULL those rows so
    // the item upsert loop below re-uploads them under `item-photo/`
    // (the correct production prefix). The R2 objects at the old prefix
    // become orphans — harmless storage, but worth a manual sweep later.
    // No-op once every row is migrated.
    const stale = await prisma.$executeRaw`
      UPDATE items SET "photoUrl" = NULL WHERE "photoUrl" LIKE 'menu-items/%'
    `;
    if (stale > 0) {
      console.log(`  ! cleaned ${stale} stale menu-items/* photoUrls`);
    }

    for (const v of VENDORS) {
      const user = await prisma.user.upsert({
        where: { phone: v.ownerPhone },
        update: { isActive: true, role: UserRole.VENDOR, displayName: v.ownerName },
        create: { phone: v.ownerPhone, role: UserRole.VENDOR, displayName: v.ownerName },
      });

      const vendorLat = PILOT_ZONE.center.lat + v.latOffset;
      const vendorLng = PILOT_ZONE.center.lng + v.lngOffset;
      const badge = BADGE_FOR_TYPE[v.type];

      const existing = await prisma.vendor.findUnique({
        where: { userId: user.id },
        select: { id: true, profilePhotoUrl: true },
      });

      // Photo: idempotent — only fetch + upload if the vendor doesn't
      // already have one. Means re-running the seed is cheap (no double
      // upload, no R2 churn). To force-refresh photos, NULL the column
      // manually before re-running.
      let profilePhotoUrl: string | null = existing?.profilePhotoUrl ?? null;
      if (!profilePhotoUrl) {
        const sourceUrl = PHOTO_FOR_TYPE[v.type];
        console.log(`  ↳ uploading demo photo for "${v.restaurantName}" from ${sourceUrl}`);
        profilePhotoUrl = await downloadAndUploadPhoto(sourceUrl, r2);
        console.log(`    ✓ stored as ${profilePhotoUrl}`);
      }

      let vendorId: string;
      if (!existing) {
        const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
          INSERT INTO vendors (
            id, "userId", name, "ownerName", description, type, status,
            quartier, "pointOfReference", location, badge,
            "profilePhotoUrl",
            "whatsappPhone", "momoPhone", "isOpen", "declaredCapacity",
            "createdAt", "updatedAt"
          ) VALUES (
            gen_random_uuid(), ${user.id}, ${v.restaurantName}, ${v.ownerName},
            ${v.description},
            ${v.type}::"VendorType", ${VendorStatus.ACTIVE}::"VendorStatus",
            ${PILOT_ZONE.name}, ${v.pointOfReference},
            ST_SetSRID(ST_MakePoint(${vendorLng}, ${vendorLat}), 4326)::geography,
            ${badge},
            ${profilePhotoUrl},
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
              "profilePhotoUrl" = ${profilePhotoUrl},
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
          select: { id: true, photoUrl: true },
        });

        // Photo: idempotent — only fetch + upload if the source URL is set
        // in the seed AND the existing/new row doesn't already have one.
        // Wrapped in try/catch so a single bad Unsplash URL doesn't kill
        // the entire seed run; we log + continue with null photoUrl.
        let photoUrl: string | null = item?.photoUrl ?? null;
        if (it.photoUrl && !photoUrl) {
          try {
            console.log(`  ↳ uploading menu photo for "${it.name}"`);
            photoUrl = await downloadAndUploadPhoto(it.photoUrl, r2, 'item-photo');
            console.log(`    ✓ stored as ${photoUrl}`);
          } catch (err) {
            console.warn(
              `  ⚠ menu photo upload failed for "${it.name}": ${(err as Error).message}`,
            );
            photoUrl = null;
          }
        }

        if (!item) {
          await prisma.item.create({
            data: {
              vendorId,
              name: it.name,
              description: it.description,
              priceXAF: it.priceXAF,
              isAvailable: true,
              isInStock: true,
              photoUrl,
            },
          });
        } else if (photoUrl && !item.photoUrl) {
          // Existing item that was seeded BEFORE we had photoUrls — backfill it.
          await prisma.item.update({
            where: { id: item.id },
            data: { photoUrl },
          });
          console.log(`  ~ backfilled photo on "${it.name}"`);
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
