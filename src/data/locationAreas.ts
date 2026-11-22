import type { CampusAreaKey, LocationFilterKey } from '../types';

export interface CampusAreaOption {
  key: CampusAreaKey;
  label: string;
  shortLabel: string;
  description: string;
  isOffCampus: boolean;
  zoneCenter: [number, number];
}

export const CAMPUS_AREA_OPTIONS: CampusAreaOption[] = [
  {
    key: 'obanla',
    label: 'Obanla Main Campus',
    shortLabel: 'Obanla Campus',
    description: 'SOC, SEET, ETF 3, Library, Senate & Campus Halls',
    isOffCampus: false,
    zoneCenter: [7.304, 5.137],
  },
  {
    key: 'south_gate',
    label: 'South Gate',
    shortLabel: 'South Gate',
    description: 'South Gate perimeter, Titans Hostel & nearby student lodges',
    isOffCampus: true,
    zoneCenter: [7.2962, 5.144],
  },
  {
    key: 'stateline',
    label: 'Stateline & Apatapiti',
    shortLabel: 'Stateline / Apatapiti',
    description: 'Apatapiti, Stateline & off-campus student community',
    isOffCampus: true,
    zoneCenter: [7.2915, 5.1485],
  },
  {
    key: 'north_gate',
    label: 'North Gate & Express',
    shortLabel: 'North Gate',
    description: 'North Gate corridor, Junction & expressway stops',
    isOffCampus: true,
    zoneCenter: [7.3112, 5.1342],
  },
  {
    key: 'ipinsa',
    label: 'Ipinsa Road',
    shortLabel: 'Ipinsa',
    description: 'Ipinsa residential strip & off-campus lodges',
    isOffCampus: true,
    zoneCenter: [7.314, 5.125],
  },
  {
    key: 'road_block',
    label: 'Road Block & Town',
    shortLabel: 'Road Block',
    description: 'Road Block corridor connecting campus to Akure town',
    isOffCampus: true,
    zoneCenter: [7.278, 5.165],
  },
  {
    key: 'obakekere',
    label: 'Obakekere Annex',
    shortLabel: 'Obakekere',
    description: 'Obakekere Mini Campus, annex & research facilities',
    isOffCampus: true,
    zoneCenter: [7.2625, 5.178],
  },
];

function haversineKm(a: [number, number], b: [number, number]): number {
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

/**
 * Privacy-preserving client-only snapping: converts device coordinates locally into
 * a coarse CampusAreaOption without ever sending raw lat/lng to the server.
 */
export function snapCoordsToArea(lat: number, lng: number): CampusAreaOption | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best: CampusAreaOption | null = null;
  let bestDist = Infinity;
  for (const area of CAMPUS_AREA_OPTIONS) {
    const dist = haversineKm([lat, lng], area.zoneCenter);
    if (dist < bestDist) {
      bestDist = dist;
      best = area;
    }
  }
  return best && bestDist <= 30 ? best : null;
}

export function getAreaShortLabel(areaKey?: string | null): string | null {
  if (!areaKey) return null;
  const found = CAMPUS_AREA_OPTIONS.find((a) => a.key === areaKey);
  return found ? found.shortLabel : null;
}

export function getLocationFilterLabel(
  filterKey: LocationFilterKey,
  preferredArea?: string | null
): string {
  if (filterKey === 'all') return 'All Locations';
  if (filterKey === 'my_area') {
    const label = getAreaShortLabel(preferredArea);
    return label ? `My Area (${label})` : 'My Area';
  }
  if (filterKey === 'on_campus') return 'On Campus';
  if (filterKey === 'off_campus') return 'Off Campus';
  return getAreaShortLabel(filterKey) || 'All Locations';
}
