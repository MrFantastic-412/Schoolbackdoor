import { CampusLocation, RouteInfo } from '../types';

// Default reference locations for FUTA students
export const DEFAULT_STUDENT_ORIGIN: CampusLocation = {
  id: 'origin-southgate',
  name: 'South Gate Main Entrance',
  category: 'gate',
  coordinates: [7.2965, 5.1435],
  description: 'Primary student transit and residential gateway, Obanla',
};

export const POPULAR_START_POINTS: CampusLocation[] = [
  DEFAULT_STUDENT_ORIGIN,
  {
    id: 'origin-titans',
    name: 'Titans Hostel (South Gate)',
    category: 'hostel',
    coordinates: [7.295, 5.145],
    description: 'Off-campus student hostel hub',
    isOffCampus: true,
  },
  {
    id: 'origin-senate',
    name: 'FUTA Senate Quadrangle',
    category: 'landmark',
    coordinates: [7.3039, 5.1378],
    description: 'Obanla campus center',
  },
  {
    id: 'origin-northgate',
    name: 'North Gate Link',
    category: 'gate',
    coordinates: [7.3105, 5.132],
    description: 'Expressway transit junction',
  },
];

/**
 * Calculate Great-Circle Distance (in meters) between two coordinates
 */
export function calculateDistanceMeters(
  [lat1, lon1]: [number, number],
  [lat2, lon2]: [number, number]
): number {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

/**
 * Format meters to human-readable distance (e.g. 850 m or 2.4 km)
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Format duration in seconds to human-readable time (e.g. 12 mins or 1h 5m)
 */
export function formatDuration(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) {
    return `${mins} min`;
  }
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
}

/**
 * Search locations via OpenStreetMap Nominatim API with fallback
 */
export async function searchNominatim(query: string): Promise<CampusLocation[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    // Search prioritized around Akure and Ondo State (viewbox: 5.0, 7.4 to 5.3, 7.1)
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
      trimmed + ' Akure Nigeria'
    )}&limit=6&addressdetails=1`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept-Language': 'en',
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Nominatim error: ${res.status}`);
    }

    const data = await res.json();
    return data.map((item: any, index: number) => {
      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lon);
      const displayName = item.display_name || '';
      const nameParts = displayName.split(',');
      const shortName = nameParts[0] || item.name || 'Pinned Location';

      return {
        id: `osm-${item.place_id || index}-${Date.now()}`,
        name: shortName.trim(),
        category: 'off_campus',
        coordinates: [lat, lon],
        description: displayName,
        address: displayName,
        isOffCampus: true,
      };
    });
  } catch (err) {
    // Return empty array on network failure; local presets remain available
    return [];
  }
}

/**
 * Reverse geocode a tapped coordinate to an address/place name via Nominatim
 */
export async function reverseGeocode(
  lat: number,
  lon: number
): Promise<{ name: string; address: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=17&addressdetails=1`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept-Language': 'en' },
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = await res.json();

    const road =
      data.address?.road ||
      data.address?.suburb ||
      data.address?.neighbourhood ||
      data.address?.residential;
    const place = data.name || data.address?.amenity || data.address?.building;

    let derivedName = '';
    if (place) {
      derivedName = place;
    } else if (road) {
      derivedName = `${road}, Akure`;
    } else {
      derivedName = `Spot near ${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E`;
    }

    return {
      name: derivedName,
      address: data.display_name || '',
    };
  } catch (err) {
    return null;
  }
}

/**
 * Calculate route between two points using OSRM with smart client-side fallback
 */
export async function calculateRoute(
  origin: [number, number],
  destination: [number, number],
  mode: 'foot' | 'driving' = 'foot'
): Promise<RouteInfo> {
  const profile = mode === 'foot' ? 'foot' : 'driving';
  // OSRM expects lon,lat format
  const osrmMode = mode === 'foot' ? 'foot' : 'car';
  const url = `https://router.project-osrm.org/route/v1/${osrmMode}/${origin[1]},${origin[0]};${destination[1]},${destination[0]}?overview=full&geometries=geojson`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data.routes && data.routes[0]) {
        const route = data.routes[0];
        // GeoJSON coordinates are [lon, lat] -> convert to [lat, lon] for Leaflet
        const coords: [number, number][] = route.geometry.coordinates.map(
          ([lon, lat]: [number, number]) => [lat, lon]
        );

        return {
          distanceMeters: Math.round(route.distance),
          durationSeconds: Math.round(route.duration),
          coordinates: coords,
          summary: route.legs?.[0]?.summary || undefined,
          profile,
        };
      }
    }
  } catch (err) {
    // Fall through to resilient synthetic interpolation
  }

  // Resilient fallback: calculate road-weighted distance and generate step waypoints
  const directMeters = calculateDistanceMeters(origin, destination);
  const roadFactor = 1.25; // Real street network path curvature
  const distanceMeters = Math.round(directMeters * roadFactor);

  // Average walking speed ~1.35 m/s (~4.8 km/h), driving ~9 m/s (~32 km/h campus/town)
  const speed = mode === 'foot' ? 1.35 : 9.0;
  const durationSeconds = Math.round(distanceMeters / speed);

  // Generate intermediate waypoint line
  const steps = 6;
  const coordinates: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const fraction = i / steps;
    // Add slight natural curve offset to simulate streets
    const curvature = Math.sin(fraction * Math.PI) * 0.0006;
    const lat = origin[0] + (destination[0] - origin[0]) * fraction + curvature;
    const lng = origin[1] + (destination[1] - origin[1]) * fraction - curvature;
    coordinates.push([lat, lng]);
  }

  return {
    distanceMeters,
    durationSeconds,
    coordinates,
    profile,
  };
}

/**
 * Generate external navigation deep links
 */
export function getGoogleMapsUrl(
  dest: [number, number],
  origin?: [number, number],
  mode: 'walking' | 'driving' = 'walking'
): string {
  const originParam = origin ? `&origin=${origin[0]},${origin[1]}` : '';
  return `https://www.google.com/maps/dir/?api=1&destination=${dest[0]},${dest[1]}${originParam}&travelmode=${mode}`;
}

export function getAppleMapsUrl(
  dest: [number, number],
  origin?: [number, number],
  mode: 'w' | 'd' = 'w'
): string {
  const originParam = origin ? `&saddr=${origin[0]},${origin[1]}` : '';
  return `https://maps.apple.com/?daddr=${dest[0]},${dest[1]}${originParam}&dirflg=${mode}`;
}

export function getOpenStreetMapUrl(
  dest: [number, number],
  origin?: [number, number]
): string {
  if (origin) {
    return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${origin[0]}%2C${origin[1]}%3B${dest[0]}%2C${dest[1]}`;
  }
  return `https://www.openstreetmap.org/?mlat=${dest[0]}&mlon=${dest[1]}#map=17/${dest[0]}/${dest[1]}`;
}
