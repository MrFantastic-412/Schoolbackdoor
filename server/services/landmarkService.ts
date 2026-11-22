import { db, runInTransaction, withReadConnection } from '../db/database';
import { cache } from '../utils/cache';
import { escapeLikePattern } from '../utils/security';

export interface LandmarkRecord {
  id: string;
  name: string;
  category: 'academic' | 'hostel' | 'gate' | 'landmark' | 'sports' | 'off_campus';
  campusZone: string;
  coordinates: [number, number];
  description?: string;
  isOffCampus: boolean;
  pinnedCount: number;
  createdAt: string;
}

export const INITIAL_LANDMARKS = [
  {
    id: 'spot-etf3',
    name: 'ETF 3 Lecture Theatre',
    category: 'academic',
    campus_zone: 'On-Campus (Obanla)',
    coordinates_lat: 7.3048,
    coordinates_lng: 5.136,
    description: 'Central multi-level lecture hall complex, Obanla Campus',
    is_off_campus: 0,
  },
  {
    id: 'spot-seet',
    name: 'SEET Complex & Engineering Workshops',
    category: 'academic',
    campus_zone: 'On-Campus (Obanla)',
    coordinates_lat: 7.3052,
    coordinates_lng: 5.1345,
    description: 'School of Engineering laboratories, Obanla',
    is_off_campus: 0,
  },
  {
    id: 'spot-soc',
    name: 'School of Computing (SOC Complex)',
    category: 'academic',
    campus_zone: 'On-Campus (Obanla)',
    coordinates_lat: 7.3041,
    coordinates_lng: 5.1352,
    description: 'Computer Science & Software Engineering faculty building',
    is_off_campus: 0,
  },
  {
    id: 'spot-library',
    name: 'Albert Ilemobade University Library',
    category: 'academic',
    campus_zone: 'On-Campus (Obanla)',
    coordinates_lat: 7.3028,
    coordinates_lng: 5.1392,
    description: 'Main campus research library and 24h reading halls',
    is_off_campus: 0,
  },
  {
    id: 'spot-senate',
    name: 'FUTA Senate & Administrative Building',
    category: 'landmark',
    campus_zone: 'On-Campus (Obanla)',
    coordinates_lat: 7.3039,
    coordinates_lng: 5.1378,
    description: 'Principal university administration & Vice-Chancellor quadrangle',
    is_off_campus: 0,
  },
  {
    id: 'spot-sports',
    name: 'University Sports Complex',
    category: 'sports',
    campus_zone: 'On-Campus (Obanla)',
    coordinates_lat: 7.306,
    coordinates_lng: 5.141,
    description: 'Football stadium, tennis courts & collegiate sports pavilion',
    is_off_campus: 0,
  },
  {
    id: 'spot-jibowu',
    name: 'Jibowu Hall of Residence',
    category: 'hostel',
    campus_zone: 'On-Campus (Obanla)',
    coordinates_lat: 7.301,
    coordinates_lng: 5.1362,
    description: 'On-campus undergraduate residential hall, Obanla',
    is_off_campus: 0,
  },
  {
    id: 'spot-akindeko',
    name: 'Akindeko Hall of Residence',
    category: 'hostel',
    campus_zone: 'On-Campus (Obanla)',
    coordinates_lat: 7.3015,
    coordinates_lng: 5.135,
    description: 'On-campus student residential hall, Obanla',
    is_off_campus: 0,
  },
  {
    id: 'spot-southgate',
    name: 'South Gate Main Entrance',
    category: 'gate',
    campus_zone: 'On-Campus Perimeter',
    coordinates_lat: 7.2965,
    coordinates_lng: 5.1435,
    description: 'Primary transit nexus, commercial trade hub & shuttle terminus',
    is_off_campus: 0,
  },
  {
    id: 'spot-northgate',
    name: 'North Gate Entrance & Express Link',
    category: 'gate',
    campus_zone: 'On-Campus Perimeter',
    coordinates_lat: 7.3105,
    coordinates_lng: 5.132,
    description: 'Ilesha-Akure expressway university entrance gate',
    is_off_campus: 0,
  },
  {
    id: 'spot-titans',
    name: 'Titans Hostel',
    category: 'hostel',
    campus_zone: 'Off-Campus (South Gate)',
    coordinates_lat: 7.295,
    coordinates_lng: 5.145,
    description: 'Off-campus student residential hostel hub, South Gate',
    is_off_campus: 1,
  },
  {
    id: 'spot-stateline',
    name: 'Stateline & Apatapiti Residences',
    category: 'off_campus',
    campus_zone: 'Off-Campus (South Gate)',
    coordinates_lat: 7.2915,
    coordinates_lng: 5.1485,
    description: 'Popular high-density off-campus student community south of South Gate',
    is_off_campus: 1,
  },
  {
    id: 'spot-ipinsa',
    name: 'Ipinsa Road Student Hostels',
    category: 'off_campus',
    campus_zone: 'Off-Campus (North Gate)',
    coordinates_lat: 7.314,
    coordinates_lng: 5.125,
    description: 'Quiet off-campus residential strip past North Gate',
    is_off_campus: 1,
  },
  {
    id: 'spot-futajunction',
    name: 'FUTA Junction / Expressway Bus Stop',
    category: 'off_campus',
    campus_zone: 'Off-Campus (Expressway)',
    coordinates_lat: 7.3125,
    coordinates_lng: 5.137,
    description: 'Major inter-city transit and shuttle drop-off point',
    is_off_campus: 1,
  },
  {
    id: 'spot-roadblock',
    name: 'Road Block Junction',
    category: 'off_campus',
    campus_zone: 'Off-Campus (Town Link)',
    coordinates_lat: 7.278,
    coordinates_lng: 5.165,
    description: 'Town corridor linking Obanla and Akure metropolis',
    is_off_campus: 1,
  },
  {
    id: 'spot-obakekere',
    name: 'Obakekere Campus (Mini Campus)',
    category: 'landmark',
    campus_zone: 'Off-Campus (Annex)',
    coordinates_lat: 7.2625,
    coordinates_lng: 5.178,
    description: 'Pre-degree, postgraduate & research annex campus',
    is_off_campus: 1,
  },
];

export const landmarkService = {
  ensureLandmarksSeeded() {
    try {
      const countRow = db.prepare('SELECT COUNT(*) as count FROM landmarks').get() as { count: number };
      if (!countRow || countRow.count === 0) {
        const stmt = db.prepare(`
          INSERT INTO landmarks (
            id, name, category, campus_zone, coordinates_lat, coordinates_lng, description, is_off_campus, pinned_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        `);

        runInTransaction(() => {
          for (const spot of INITIAL_LANDMARKS) {
            stmt.run(
              spot.id,
              spot.name,
              spot.category,
              spot.campus_zone,
              spot.coordinates_lat,
              spot.coordinates_lng,
              spot.description,
              spot.is_off_campus
            );
          }
        });
      }
    } catch (e) {
      console.warn('[landmarkService] ensureLandmarksSeeded error:', e);
    }
  },

  getAllLandmarks(options: { zone?: string; category?: string; search?: string; isOffCampus?: boolean } = {}) {
    const cacheKey = `landmarks:list:${options.zone || 'all'}:${options.category || 'all'}:${(options.search || '').trim().toLowerCase()}:${options.isOffCampus ?? 'any'}`;
    return cache.getOrCompute<LandmarkRecord[]>(cacheKey, 60000, () => {
      this.ensureLandmarksSeeded();

      let query = 'SELECT * FROM landmarks WHERE 1=1';
      const params: any[] = [];

      if (options.zone && options.zone !== 'all') {
        if (options.zone === 'on_campus') {
          query += ' AND is_off_campus = 0';
        } else if (options.zone === 'off_campus') {
          query += ' AND is_off_campus = 1';
        } else {
          query += " AND campus_zone LIKE ? ESCAPE '\\'";
          params.push(`%${escapeLikePattern(options.zone)}%`);
        }
      }

      if (options.category && options.category !== 'all') {
        query += ' AND category = ?';
        params.push(options.category);
      }

      if (options.search && options.search.trim()) {
        query += " AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR campus_zone LIKE ? ESCAPE '\\')";
        const term = `%${escapeLikePattern(options.search.trim())}%`;
        params.push(term, term, term);
      }

      query += ' ORDER BY pinned_count DESC, name ASC';

      const rows = withReadConnection((conn) => conn.prepare(query).all(...params) as any[]);
      return rows.map((r) => this.mapRowToLandmark(r));
    });
  },

  getLandmarkById(id: string): LandmarkRecord | null {
    return cache.getOrCompute<LandmarkRecord | null>(`landmarks:one:${id}`, 60000, () => {
      this.ensureLandmarksSeeded();
      const row = withReadConnection((conn) => conn.prepare('SELECT * FROM landmarks WHERE id = ?').get(id) as any);
      if (!row) return null;
      return this.mapRowToLandmark(row);
    });
  },

  incrementPinCount(id: string) {
    db.prepare('UPDATE landmarks SET pinned_count = pinned_count + 1 WHERE id = ?').run(id);
    cache.invalidatePrefix('landmarks:');
  },

  mapRowToLandmark(r: any): LandmarkRecord {
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      campusZone: r.campus_zone,
      coordinates: [r.coordinates_lat, r.coordinates_lng],
      description: r.description || undefined,
      isOffCampus: Boolean(r.is_off_campus),
      pinnedCount: r.pinned_count || 0,
      createdAt: r.created_at,
    };
  },
};
