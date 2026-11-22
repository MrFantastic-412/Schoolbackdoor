/**
 * Coarse Campus & Surrounding Area Taxonomy
 * Supports location-based feed relevance without storing or exposing precise user GPS coordinates.
 */

export type CampusAreaKey =
  | 'obanla'
  | 'south_gate'
  | 'stateline'
  | 'north_gate'
  | 'ipinsa'
  | 'road_block'
  | 'obakekere';

export type LocationFilterKey =
  | 'all'
  | 'my_area'
  | 'on_campus'
  | 'off_campus'
  | CampusAreaKey;

export interface CampusAreaDefinition {
  key: CampusAreaKey;
  label: string;
  shortLabel: string;
  description: string;
  isOffCampus: boolean;
  /** Coarse zone center used solely for zone-to-zone proximity ranking (never exposed as user GPS) */
  zoneCenter: [number, number];
  nearbyZones: CampusAreaKey[];
  keywords: string[];
}

export const CAMPUS_AREAS: CampusAreaDefinition[] = [
  {
    key: 'obanla',
    label: 'Obanla Main Campus',
    shortLabel: 'Obanla Campus',
    description: 'SOC, SEET, ETF 3, Library, Senate, Jibowu & Akindeko Halls',
    isOffCampus: false,
    zoneCenter: [7.304, 5.137],
    nearbyZones: ['south_gate', 'north_gate'],
    keywords: [
      'obanla',
      'etf',
      'seet',
      'soc',
      'library',
      'ilemobade',
      'senate',
      'sports complex',
      'jibowu',
      'akindeko',
      'academic',
      'on-campus',
      'main campus',
      'sug',
    ],
  },
  {
    key: 'south_gate',
    label: 'South Gate',
    shortLabel: 'South Gate',
    description: 'South Gate perimeter, Titans Hostel & nearby student lodges',
    isOffCampus: true,
    zoneCenter: [7.2962, 5.144],
    nearbyZones: ['stateline', 'obanla', 'road_block'],
    keywords: ['south gate', 'southgate', 'south_gate', 'titans', 'tita'],
  },
  {
    key: 'stateline',
    label: 'Stateline & Apatapiti',
    shortLabel: 'Stateline / Apatapiti',
    description: 'Apatapiti, Stateline & off-campus student community south of South Gate',
    isOffCampus: true,
    zoneCenter: [7.2915, 5.1485],
    nearbyZones: ['south_gate', 'road_block', 'obanla'],
    keywords: ['stateline', 'apatapiti'],
  },
  {
    key: 'north_gate',
    label: 'North Gate & Express',
    shortLabel: 'North Gate',
    description: 'North Gate corridor, FUTA Junction & expressway stops',
    isOffCampus: true,
    zoneCenter: [7.3112, 5.1342],
    nearbyZones: ['obanla', 'ipinsa'],
    keywords: ['north gate', 'northgate', 'north_gate', 'junction', 'express'],
  },
  {
    key: 'ipinsa',
    label: 'Ipinsa Road',
    shortLabel: 'Ipinsa',
    description: 'Ipinsa residential strip & off-campus lodges north of North Gate',
    isOffCampus: true,
    zoneCenter: [7.314, 5.125],
    nearbyZones: ['north_gate', 'obanla'],
    keywords: ['ipinsa'],
  },
  {
    key: 'road_block',
    label: 'Road Block & Town',
    shortLabel: 'Road Block',
    description: 'Road Block corridor connecting campus to Akure town',
    isOffCampus: true,
    zoneCenter: [7.278, 5.165],
    nearbyZones: ['stateline', 'south_gate', 'obakekere'],
    keywords: ['road block', 'roadblock', 'road_block', 'akure town'],
  },
  {
    key: 'obakekere',
    label: 'Obakekere Annex',
    shortLabel: 'Obakekere',
    description: 'Obakekere Mini Campus, annex & research facilities',
    isOffCampus: true,
    zoneCenter: [7.2625, 5.178],
    nearbyZones: ['road_block', 'stateline'],
    keywords: ['obakekere', 'mini campus', 'annex'],
  },
];

const AREA_MAP = new Map<CampusAreaKey, CampusAreaDefinition>(
  CAMPUS_AREAS.map((a) => [a.key, a])
);

const VALID_AREA_KEYS = new Set<string>(CAMPUS_AREAS.map((a) => a.key));

export function getAreaDefinition(key?: string | null): CampusAreaDefinition | null {
  if (!key) return null;
  const normalized = normalizeAreaKey(key);
  return normalized ? AREA_MAP.get(normalized) || null : null;
}

export function haversineDistanceKm(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function findNearestAreaByCoordinates(lat: number, lng: number): CampusAreaDefinition | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best: CampusAreaDefinition | null = null;
  let bestDist = Infinity;
  for (const area of CAMPUS_AREAS) {
    const dist = haversineDistanceKm([lat, lng], area.zoneCenter);
    if (dist < bestDist) {
      bestDist = dist;
      best = area;
    }
  }
  // Only map if within 25km of the campus/surrounding region
  return best && bestDist <= 25 ? best : null;
}

export function normalizeAreaKey(raw?: string | null): CampusAreaKey | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (VALID_AREA_KEYS.has(trimmed)) {
    return trimmed as CampusAreaKey;
  }

  for (const area of CAMPUS_AREAS) {
    if (area.label.toLowerCase() === trimmed || area.shortLabel.toLowerCase() === trimmed) {
      return area.key;
    }
    for (const kw of area.keywords) {
      if (trimmed.includes(kw)) {
        return area.key;
      }
    }
  }
  return null;
}

export interface InferredPostLocation {
  areaKey: CampusAreaKey | null;
  areaLabel: string | null;
  isOffCampus: boolean | null;
  hasExplicitLocation: boolean;
  spotCoordinates: [number, number] | null;
}

export function inferPostLocation(input: {
  areaKey?: string | null;
  locationJson?: string | null;
  locationObj?: {
    id?: string;
    name?: string;
    campusZone?: string;
    description?: string;
    address?: string;
    coordinates?: [number, number];
    isOffCampus?: boolean;
  } | null;
  hostelTag?: string | null;
  schoolTag?: string | null;
  communityLocation?: string | null;
}): InferredPostLocation {
  let loc = input.locationObj || null;
  if (!loc && input.locationJson) {
    try {
      loc = JSON.parse(input.locationJson);
    } catch {
      loc = null;
    }
  }

  const spotCoords =
    loc && Array.isArray(loc.coordinates) && loc.coordinates.length === 2
      ? ([Number(loc.coordinates[0]), Number(loc.coordinates[1])] as [number, number])
      : null;

  const hasExplicitLocation = Boolean(
    (loc && (loc.name || spotCoords)) ||
      (input.hostelTag && input.hostelTag.trim()) ||
      (input.communityLocation && input.communityLocation.trim())
  );

  // 1. Check persisted or explicit areaKey first
  let areaKey = normalizeAreaKey(input.areaKey);

  // 2. Check structured location metadata (zone, name, description, address)
  if (!areaKey && loc) {
    areaKey =
      normalizeAreaKey(loc.campusZone) ||
      normalizeAreaKey(loc.name) ||
      normalizeAreaKey(loc.description) ||
      normalizeAreaKey(loc.address) ||
      null;
  }

  // 3. Snap landmark coordinates to nearest coarse area if still unmatched
  if (!areaKey && spotCoords) {
    const nearest = findNearestAreaByCoordinates(spotCoords[0], spotCoords[1]);
    if (nearest) areaKey = nearest.key;
  }

  // 4. Fallback to hostel tag, community location, or academic school tag
  if (!areaKey) {
    areaKey =
      normalizeAreaKey(input.hostelTag) ||
      normalizeAreaKey(input.communityLocation) ||
      normalizeAreaKey(input.schoolTag) ||
      null;
  }

  const areaDef = areaKey ? AREA_MAP.get(areaKey) || null : null;
  const isOffCampus =
    typeof loc?.isOffCampus === 'boolean'
      ? loc.isOffCampus
      : areaDef
      ? areaDef.isOffCampus
      : null;

  return {
    areaKey,
    areaLabel: areaDef ? areaDef.shortLabel : null,
    isOffCampus,
    hasExplicitLocation,
    spotCoordinates: spotCoords,
  };
}

/**
 * Computes a bounded [0, 1] location relevance score using coarse area keys & zone centers.
 */
export function computeLocationRelevanceScore(
  postLoc: InferredPostLocation,
  targetFilter: LocationFilterKey,
  consentedUserArea: CampusAreaKey | null
): number {
  const effectiveTargetArea: CampusAreaKey | null =
    targetFilter === 'my_area'
      ? consentedUserArea
      : VALID_AREA_KEYS.has(targetFilter)
      ? (targetFilter as CampusAreaKey)
      : targetFilter === 'all'
      ? consentedUserArea
      : null;

  // Broad On-Campus / Off-Campus filters
  if (targetFilter === 'on_campus') {
    if (postLoc.isOffCampus === false || postLoc.areaKey === 'obanla') return 1.0;
    if (postLoc.areaKey && AREA_MAP.get(postLoc.areaKey)?.nearbyZones.includes('obanla')) return 0.45;
    return postLoc.hasExplicitLocation ? 0.15 : 0.1;
  }

  if (targetFilter === 'off_campus') {
    if (postLoc.isOffCampus === true) return 1.0;
    if (postLoc.areaKey && AREA_MAP.get(postLoc.areaKey)?.isOffCampus) return 1.0;
    return postLoc.hasExplicitLocation ? 0.2 : 0.1;
  }

  if (!effectiveTargetArea) {
    // User has no location filter & has not opted into location sharing:
    // Give modest positive credit for posts tagged with a campus/community spot without over-biasing.
    return postLoc.hasExplicitLocation ? 0.45 : 0.25;
  }

  if (!postLoc.areaKey) {
    return 0.12;
  }

  if (postLoc.areaKey === effectiveTargetArea) {
    return 1.0;
  }

  const targetDef = AREA_MAP.get(effectiveTargetArea);
  const postDef = AREA_MAP.get(postLoc.areaKey);
  if (!targetDef || !postDef) return 0.15;

  if (targetDef.nearbyZones.includes(postLoc.areaKey)) {
    return 0.58;
  }

  const distKm = haversineDistanceKm(targetDef.zoneCenter, postDef.zoneCenter);
  if (distKm <= 2.2) return 0.52;
  if (distKm <= 4.0) return 0.42;
  if (targetDef.isOffCampus === postDef.isOffCampus) return 0.3;
  return 0.14;
}

export function isValidLocationFilter(value: unknown): value is LocationFilterKey {
  if (typeof value !== 'string') return false;
  return (
    value === 'all' ||
    value === 'my_area' ||
    value === 'on_campus' ||
    value === 'off_campus' ||
    VALID_AREA_KEYS.has(value)
  );
}
