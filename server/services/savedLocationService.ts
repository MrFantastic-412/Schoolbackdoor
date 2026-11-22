import crypto from 'node:crypto';
import { db, runInTransaction, withReadConnection } from '../db/database';
import { cache } from '../utils/cache';
import { escapeLikePattern, sanitizeInputText, validateLocationInput } from '../utils/security';
import { CampusAreaKey, inferPostLocation } from './locationTaxonomy';

export type SavedLocationSource = 'search' | 'map' | 'landmark' | 'post' | 'chat' | 'manual';
export type SavedLocationCategory =
  | 'academic'
  | 'hostel'
  | 'gate'
  | 'landmark'
  | 'sports'
  | 'off_campus'
  | 'custom';

export interface SavedLocationRecord {
  id: string;
  userId: string;
  landmarkId?: string;
  name: string;
  customLabel?: string;
  displayName: string;
  category: SavedLocationCategory;
  areaKey?: CampusAreaKey;
  areaLabel?: string;
  campusZone?: string;
  description?: string;
  address?: string;
  notes?: string;
  coordinates: [number, number];
  isOffCampus: boolean;
  isPinned: boolean;
  source: SavedLocationSource;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocationSearchHistoryRecord {
  id: string;
  userId: string;
  queryText: string;
  selectedName?: string;
  selectedDescription?: string;
  selectedAddress?: string;
  selectedCategory?: string;
  areaKey?: CampusAreaKey;
  areaLabel?: string;
  coordinates?: [number, number];
  isOffCampus: boolean;
  landmarkId?: string;
  searchCount: number;
  searchedAt: string;
}

export interface SaveLocationInput {
  id?: string;
  landmarkId?: string;
  name: string;
  customLabel?: string;
  category?: string;
  campusZone?: string;
  description?: string;
  address?: string;
  notes?: string;
  coordinates: [number, number];
  isOffCampus?: boolean;
  isPinned?: boolean;
  source?: string;
}

export interface UpdateSavedLocationPatch {
  name?: string;
  customLabel?: string | null;
  notes?: string | null;
  category?: string;
  isOffCampus?: boolean;
  isPinned?: boolean;
  markUsed?: boolean;
}

export interface RecordSearchHistoryInput {
  queryText: string;
  location?: {
    id?: string;
    name?: string;
    category?: string;
    campusZone?: string;
    description?: string;
    address?: string;
    coordinates?: [number, number];
    isOffCampus?: boolean;
  } | null;
}

const VALID_CATEGORIES = new Set<string>([
  'academic',
  'hostel',
  'gate',
  'landmark',
  'sports',
  'off_campus',
  'custom',
]);

const VALID_SOURCES = new Set<string>(['search', 'map', 'landmark', 'post', 'chat', 'manual']);
const MAX_SAVED_LOCATIONS_PER_USER = 200;
const MAX_SEARCH_HISTORY_PER_USER = 50;

function normalizeCategory(raw?: string | null): SavedLocationCategory {
  if (!raw || typeof raw !== 'string') return 'custom';
  const clean = raw.trim().toLowerCase();
  return VALID_CATEGORIES.has(clean) ? (clean as SavedLocationCategory) : 'custom';
}

function normalizeSource(raw?: string | null): SavedLocationSource {
  if (!raw || typeof raw !== 'string') return 'manual';
  const clean = raw.trim().toLowerCase();
  return VALID_SOURCES.has(clean) ? (clean as SavedLocationSource) : 'manual';
}

function isKnownLandmarkId(rawId?: string | null): boolean {
  if (!rawId || typeof rawId !== 'string') return false;
  const clean = rawId.trim();
  if (!clean) return false;
  return (
    !clean.startsWith('custom-') &&
    !clean.startsWith('osm-') &&
    !clean.startsWith('saved-') &&
    !clean.startsWith('loc-') &&
    !clean.startsWith('hist-') &&
    !clean.startsWith('spot-') &&
    !clean.startsWith('pin-') &&
    !clean.startsWith('gps-')
  );
}

export function buildLocationDedupeKey(coords: [number, number], landmarkId?: string | null): string {
  const latKey = Number(coords[0]).toFixed(4);
  const lngKey = Number(coords[1]).toFixed(4);
  if (landmarkId && isKnownLandmarkId(landmarkId)) {
    return `lm:${landmarkId.trim().slice(0, 64)}`;
  }
  return `coords:${latKey},${lngKey}`;
}

function mapSavedRow(row: any): SavedLocationRecord {
  const name = row.name || 'Saved Location';
  const customLabel = row.custom_label || undefined;
  const inferred = inferPostLocation({
    areaKey: row.area_key,
    locationObj: {
      name,
      campusZone: row.campus_zone || undefined,
      description: row.description || undefined,
      address: row.address || undefined,
      coordinates: [Number(row.coordinates_lat), Number(row.coordinates_lng)],
      isOffCampus: Boolean(row.is_off_campus),
    },
  });

  return {
    id: row.id,
    userId: row.user_id,
    landmarkId: row.landmark_id || undefined,
    name,
    customLabel,
    displayName: customLabel || name,
    category: normalizeCategory(row.category),
    areaKey: (row.area_key || inferred.areaKey || undefined) as CampusAreaKey | undefined,
    areaLabel: inferred.areaLabel || undefined,
    campusZone: row.campus_zone || undefined,
    description: row.description || undefined,
    address: row.address || undefined,
    notes: row.notes || undefined,
    coordinates: [Number(row.coordinates_lat), Number(row.coordinates_lng)],
    isOffCampus: Boolean(row.is_off_campus),
    isPinned: Boolean(row.is_pinned),
    source: normalizeSource(row.source),
    lastUsedAt: row.last_used_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHistoryRow(row: any): LocationSearchHistoryRecord {
  const hasCoords =
    typeof row.coordinates_lat === 'number' &&
    typeof row.coordinates_lng === 'number' &&
    Number.isFinite(row.coordinates_lat) &&
    Number.isFinite(row.coordinates_lng);

  const inferred = inferPostLocation({
    areaKey: row.area_key,
    locationObj: {
      name: row.selected_name || row.query_text,
      description: row.selected_description || undefined,
      address: row.selected_address || undefined,
      coordinates: hasCoords ? [Number(row.coordinates_lat), Number(row.coordinates_lng)] : undefined,
      isOffCampus: Boolean(row.is_off_campus),
    },
  });

  return {
    id: row.id,
    userId: row.user_id,
    queryText: row.query_text,
    selectedName: row.selected_name || undefined,
    selectedDescription: row.selected_description || undefined,
    selectedAddress: row.selected_address || undefined,
    selectedCategory: row.selected_category || undefined,
    areaKey: (row.area_key || inferred.areaKey || undefined) as CampusAreaKey | undefined,
    areaLabel: inferred.areaLabel || undefined,
    coordinates: hasCoords ? [Number(row.coordinates_lat), Number(row.coordinates_lng)] : undefined,
    isOffCampus: Boolean(row.is_off_campus),
    landmarkId: row.landmark_id || undefined,
    searchCount: Number(row.search_count || 1),
    searchedAt: row.searched_at,
  };
}

function cacheKeyForUser(userId: string): string {
  return `userlocs:${userId}`;
}

export const savedLocationService = {
  invalidateUserCache(userId: string) {
    if (!userId) return;
    cache.invalidate(cacheKeyForUser(userId));
  },

  listSavedLocations(
    userId: string,
    options: { search?: string; filter?: 'all' | 'pinned' | 'saved' | 'off_campus' | 'on_campus' } = {}
  ): SavedLocationRecord[] {
    if (!userId) return [];
    const search = typeof options.search === 'string' ? options.search.trim() : '';
    const filter = options.filter || 'all';

    return withReadConnection((conn) => {
      let sql = 'SELECT * FROM saved_locations WHERE user_id = ?';
      const params: Array<string | number> = [userId];

      if (filter === 'pinned') {
        sql += ' AND is_pinned = 1';
      } else if (filter === 'saved') {
        sql += ' AND is_pinned = 0';
      } else if (filter === 'off_campus') {
        sql += ' AND is_off_campus = 1';
      } else if (filter === 'on_campus') {
        sql += ' AND is_off_campus = 0';
      }

      if (search) {
        const escaped = `%${escapeLikePattern(search.toLowerCase())}%`;
        sql +=
          " AND (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(custom_label, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(notes, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(address, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(campus_zone, '')) LIKE ? ESCAPE '\\')";
        params.push(escaped, escaped, escaped, escaped, escaped);
      }

      sql += ' ORDER BY is_pinned DESC, COALESCE(last_used_at, updated_at) DESC, created_at DESC LIMIT 200';
      const rows = conn.prepare(sql).all(...params) as any[];
      return rows.map(mapSavedRow);
    });
  },

  listSearchHistory(
    userId: string,
    options: { search?: string; limit?: number } = {}
  ): LocationSearchHistoryRecord[] {
    if (!userId) return [];
    const search = typeof options.search === 'string' ? options.search.trim() : '';
    const limit = Math.min(50, Math.max(1, Number(options.limit) || 25));

    return withReadConnection((conn) => {
      let sql = 'SELECT * FROM location_search_history WHERE user_id = ?';
      const params: Array<string | number> = [userId];

      if (search) {
        const escaped = `%${escapeLikePattern(search.toLowerCase())}%`;
        sql +=
          " AND (LOWER(query_text) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(selected_name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(selected_address, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(selected_description, '')) LIKE ? ESCAPE '\\')";
        params.push(escaped, escaped, escaped, escaped);
      }

      sql += ' ORDER BY searched_at DESC LIMIT ?';
      params.push(limit);

      const rows = conn.prepare(sql).all(...params) as any[];
      return rows.map(mapHistoryRow);
    });
  },

  getLocationsOverview(
    userId: string,
    options: { search?: string; filter?: 'all' | 'pinned' | 'saved' | 'off_campus' | 'on_campus' } = {}
  ): {
    savedLocations: SavedLocationRecord[];
    searchHistory: LocationSearchHistoryRecord[];
  } {
    if (!userId) {
      return { savedLocations: [], searchHistory: [] };
    }

    const search = typeof options.search === 'string' ? options.search.trim() : '';
    const filter = options.filter || 'all';

    if (!search && filter === 'all') {
      return cache.getOrCompute(cacheKeyForUser(userId), 15_000, () => ({
        savedLocations: this.listSavedLocations(userId),
        searchHistory: this.listSearchHistory(userId),
      }));
    }

    return {
      savedLocations: this.listSavedLocations(userId, { search, filter }),
      searchHistory: this.listSearchHistory(userId, { search }),
    };
  },

  saveOrPinLocation(userId: string, rawInput: SaveLocationInput): SavedLocationRecord {
    if (!userId) {
      throw new Error('Authentication required to save locations.');
    }

    const validated = validateLocationInput({
      id: rawInput.landmarkId || rawInput.id,
      name: rawInput.name,
      coordinates: rawInput.coordinates,
      category: rawInput.category,
      campusZone: rawInput.campusZone,
      description: rawInput.description,
      isOffCampus: rawInput.isOffCampus,
    });
    if (!validated) {
      throw new Error('Valid location payload is required.');
    }

    const landmarkId =
      rawInput.landmarkId && isKnownLandmarkId(rawInput.landmarkId)
        ? rawInput.landmarkId.trim().slice(0, 64)
        : isKnownLandmarkId(rawInput.id)
        ? rawInput.id!.trim().slice(0, 64)
        : null;

    const dedupeKey = buildLocationDedupeKey(validated.coordinates, landmarkId);
    const customLabel =
      typeof rawInput.customLabel === 'string'
        ? sanitizeInputText(rawInput.customLabel, 120) || null
        : null;
    const address =
      typeof rawInput.address === 'string' ? sanitizeInputText(rawInput.address, 280) || null : null;
    const notes =
      typeof rawInput.notes === 'string' ? sanitizeInputText(rawInput.notes, 300) || null : null;
    const category = normalizeCategory(validated.category || rawInput.category);
    const source = normalizeSource(rawInput.source);
    const isPinned = rawInput.isPinned ? 1 : 0;

    const inferred = inferPostLocation({
      locationObj: {
        id: landmarkId || validated.id,
        name: validated.name,
        campusZone: validated.campusZone,
        description: validated.description,
        address: address || undefined,
        coordinates: validated.coordinates,
        isOffCampus: validated.isOffCampus,
      },
    });
    const isOffCampus =
      typeof rawInput.isOffCampus === 'boolean'
        ? rawInput.isOffCampus
          ? 1
          : 0
        : inferred.isOffCampus
        ? 1
        : 0;

    const coordsKey = `coords:${Number(validated.coordinates[0]).toFixed(4)},${Number(
      validated.coordinates[1]
    ).toFixed(4)}`;

    const row = runInTransaction(() => {
      // Also match existing saved spot at identical 4-decimal coordinates even if one originated via preset & another via OSM/tap
      const existing = db
        .prepare(
          `
          SELECT * FROM saved_locations
          WHERE user_id = ?
            AND (dedupe_key = ? OR dedupe_key = ? OR (? IS NOT NULL AND landmark_id = ?))
          LIMIT 1
        `
        )
        .get(userId, dedupeKey, coordsKey, landmarkId, landmarkId) as any;

      if (existing) {
        const nextPinned = Math.max(existing.is_pinned ? 1 : 0, isPinned);
        const nextCustomLabel =
          customLabel !== null
            ? customLabel
            : existing.custom_label ||
              (validated.name !== existing.name ? sanitizeInputText(validated.name, 120) : null);
        db.prepare(
          `
          UPDATE saved_locations
          SET name = COALESCE(?, name),
              custom_label = ?,
              landmark_id = COALESCE(landmark_id, ?),
              category = ?,
              area_key = COALESCE(?, area_key),
              campus_zone = COALESCE(?, campus_zone),
              description = COALESCE(?, description),
              address = COALESCE(?, address),
              notes = COALESCE(?, notes),
              is_off_campus = ?,
              is_pinned = ?,
              source = CASE WHEN ? != 'manual' THEN ? ELSE source END,
              last_used_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?
        `
        ).run(
          existing.name || validated.name,
          nextCustomLabel,
          landmarkId,
          category !== 'custom' ? category : existing.category,
          inferred.areaKey || null,
          validated.campusZone || null,
          validated.description || null,
          address,
          notes,
          typeof rawInput.isOffCampus === 'boolean' ? (rawInput.isOffCampus ? 1 : 0) : existing.is_off_campus,
          nextPinned,
          source,
          source,
          existing.id,
          userId
        );
        return db.prepare('SELECT * FROM saved_locations WHERE id = ? AND user_id = ?').get(existing.id, userId) as any;
      }

      // Enforce per-user saved locations cap cleanly without blocking saves
      const countRow = db
        .prepare('SELECT COUNT(*) as cnt FROM saved_locations WHERE user_id = ?')
        .get(userId) as { cnt: number };
      if ((countRow?.cnt || 0) >= MAX_SAVED_LOCATIONS_PER_USER) {
        db.prepare(
          `
          DELETE FROM saved_locations
          WHERE id IN (
            SELECT id FROM saved_locations
            WHERE user_id = ? AND is_pinned = 0
            ORDER BY COALESCE(last_used_at, updated_at) ASC
            LIMIT 1
          )
        `
        ).run(userId);
      }

      const id = `loc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      db.prepare(
        `
        INSERT INTO saved_locations (
          id, user_id, dedupe_key, landmark_id, name, custom_label, category, area_key,
          campus_zone, description, address, notes, coordinates_lat, coordinates_lng,
          is_off_campus, is_pinned, source, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `
      ).run(
        id,
        userId,
        dedupeKey,
        landmarkId,
        validated.name,
        customLabel,
        category,
        inferred.areaKey || null,
        validated.campusZone || null,
        validated.description || null,
        address,
        notes,
        validated.coordinates[0],
        validated.coordinates[1],
        isOffCampus,
        isPinned,
        source
      );

      return db.prepare('SELECT * FROM saved_locations WHERE id = ? AND user_id = ?').get(id, userId) as any;
    });

    this.invalidateUserCache(userId);
    return mapSavedRow(row);
  },

  autoSavePinnedLocation(
    userId: string,
    loc: {
      id?: string;
      name: string;
      coordinates: [number, number];
      category?: string;
      campusZone?: string;
      description?: string;
      address?: string;
      isOffCampus?: boolean;
    },
    source: 'post' | 'chat'
  ): SavedLocationRecord {
    return this.saveOrPinLocation(userId, {
      id: loc.id,
      landmarkId: isKnownLandmarkId(loc.id) ? loc.id : undefined,
      name: loc.name,
      category: loc.category,
      campusZone: loc.campusZone,
      description: loc.description,
      address: loc.address,
      coordinates: loc.coordinates,
      isOffCampus: loc.isOffCampus,
      isPinned: true,
      source,
    });
  },

  updateSavedLocation(userId: string, locationId: string, patch: UpdateSavedLocationPatch): SavedLocationRecord {
    if (!userId) {
      throw new Error('Authentication required.');
    }

    const existing = db
      .prepare('SELECT * FROM saved_locations WHERE id = ? AND user_id = ?')
      .get(locationId, userId) as any;

    if (!existing) {
      throw new Error('Saved location not found.');
    }

    const nextName =
      typeof patch.name === 'string' && sanitizeInputText(patch.name, 120)
        ? sanitizeInputText(patch.name, 120)
        : existing.name;

    let nextCustomLabel = existing.custom_label;
    if (patch.customLabel === null) {
      nextCustomLabel = null;
    } else if (typeof patch.customLabel === 'string') {
      const cleaned = sanitizeInputText(patch.customLabel, 120);
      nextCustomLabel = cleaned || null;
    }

    let nextNotes = existing.notes;
    if (patch.notes === null) {
      nextNotes = null;
    } else if (typeof patch.notes === 'string') {
      const cleaned = sanitizeInputText(patch.notes, 300);
      nextNotes = cleaned || null;
    }

    const nextCategory =
      typeof patch.category === 'string' ? normalizeCategory(patch.category) : existing.category;
    const nextOffCampus =
      typeof patch.isOffCampus === 'boolean' ? (patch.isOffCampus ? 1 : 0) : existing.is_off_campus;
    const nextPinned =
      typeof patch.isPinned === 'boolean' ? (patch.isPinned ? 1 : 0) : existing.is_pinned;

    db.prepare(
      `
      UPDATE saved_locations
      SET name = ?,
          custom_label = ?,
          notes = ?,
          category = ?,
          is_off_campus = ?,
          is_pinned = ?,
          last_used_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_used_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `
    ).run(
      nextName,
      nextCustomLabel,
      nextNotes,
      nextCategory,
      nextOffCampus,
      nextPinned,
      patch.markUsed ? 1 : 0,
      locationId,
      userId
    );

    const updated = db
      .prepare('SELECT * FROM saved_locations WHERE id = ? AND user_id = ?')
      .get(locationId, userId) as any;

    this.invalidateUserCache(userId);
    return mapSavedRow(updated);
  },

  deleteSavedLocation(userId: string, locationId: string): { success: true; deletedId: string } {
    if (!userId) {
      throw new Error('Authentication required.');
    }
    const res = db
      .prepare('DELETE FROM saved_locations WHERE id = ? AND user_id = ?')
      .run(locationId, userId);

    if (!res.changes) {
      throw new Error('Saved location not found.');
    }
    this.invalidateUserCache(userId);
    return { success: true, deletedId: locationId };
  },

  recordSearchHistory(userId: string, input: RecordSearchHistoryInput): LocationSearchHistoryRecord {
    if (!userId) {
      throw new Error('Authentication required.');
    }

    const queryText = sanitizeInputText(input.queryText || '', 120);
    let validatedLoc: ReturnType<typeof validateLocationInput> = null;
    if (input.location && input.location.name && Array.isArray(input.location.coordinates)) {
      validatedLoc = validateLocationInput(input.location);
    }

    if (!queryText && !validatedLoc) {
      throw new Error('Search query or location is required.');
    }

    const effectiveQuery = queryText || validatedLoc!.name;
    const landmarkId =
      validatedLoc && isKnownLandmarkId(input.location?.id || validatedLoc.id)
        ? (input.location?.id || validatedLoc.id).trim().slice(0, 64)
        : null;

    const dedupeKey = validatedLoc
      ? buildLocationDedupeKey(validatedLoc.coordinates, landmarkId)
      : `q:${effectiveQuery.toLowerCase()}`;

    const inferred = validatedLoc
      ? inferPostLocation({
          locationObj: {
            id: landmarkId || validatedLoc.id,
            name: validatedLoc.name,
            campusZone: validatedLoc.campusZone,
            description: validatedLoc.description,
            address: input.location?.address,
            coordinates: validatedLoc.coordinates,
            isOffCampus: validatedLoc.isOffCampus,
          },
        })
      : null;

    const address =
      typeof input.location?.address === 'string'
        ? sanitizeInputText(input.location.address, 280) || null
        : null;

    const row = runInTransaction(() => {
      const id = `hist-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      db.prepare(
        `
        INSERT INTO location_search_history (
          id, user_id, dedupe_key, query_text, selected_name, selected_description,
          selected_address, selected_category, area_key, coordinates_lat, coordinates_lng,
          is_off_campus, landmark_id, search_count, searched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, dedupe_key) DO UPDATE SET
          query_text = COALESCE(NULLIF(excluded.query_text, ''), location_search_history.query_text),
          selected_name = COALESCE(excluded.selected_name, location_search_history.selected_name),
          selected_description = COALESCE(excluded.selected_description, location_search_history.selected_description),
          selected_address = COALESCE(excluded.selected_address, location_search_history.selected_address),
          selected_category = COALESCE(excluded.selected_category, location_search_history.selected_category),
          area_key = COALESCE(excluded.area_key, location_search_history.area_key),
          coordinates_lat = COALESCE(excluded.coordinates_lat, location_search_history.coordinates_lat),
          coordinates_lng = COALESCE(excluded.coordinates_lng, location_search_history.coordinates_lng),
          is_off_campus = excluded.is_off_campus,
          landmark_id = COALESCE(excluded.landmark_id, location_search_history.landmark_id),
          search_count = location_search_history.search_count + 1,
          searched_at = CURRENT_TIMESTAMP
      `
      ).run(
        id,
        userId,
        dedupeKey,
        effectiveQuery,
        validatedLoc?.name || null,
        validatedLoc?.description || null,
        address,
        validatedLoc?.category || null,
        inferred?.areaKey || null,
        validatedLoc ? validatedLoc.coordinates[0] : null,
        validatedLoc ? validatedLoc.coordinates[1] : null,
        validatedLoc?.isOffCampus || inferred?.isOffCampus ? 1 : 0,
        landmarkId
      );

      // Keep at most 50 recent history items per user
      db.prepare(
        `
        DELETE FROM location_search_history
        WHERE user_id = ?
          AND id NOT IN (
            SELECT id FROM location_search_history
            WHERE user_id = ?
            ORDER BY searched_at DESC
            LIMIT ?
          )
      `
      ).run(userId, userId, MAX_SEARCH_HISTORY_PER_USER);

      return db
        .prepare('SELECT * FROM location_search_history WHERE user_id = ? AND dedupe_key = ?')
        .get(userId, dedupeKey) as any;
    });

    this.invalidateUserCache(userId);
    return mapHistoryRow(row);
  },

  deleteSearchHistoryItem(userId: string, historyId: string): { success: true; deletedId: string } {
    if (!userId) {
      throw new Error('Authentication required.');
    }
    const res = db
      .prepare('DELETE FROM location_search_history WHERE id = ? AND user_id = ?')
      .run(historyId, userId);

    if (!res.changes) {
      throw new Error('Search history entry not found.');
    }
    this.invalidateUserCache(userId);
    return { success: true, deletedId: historyId };
  },

  clearSearchHistory(userId: string): { success: true; clearedCount: number } {
    if (!userId) {
      throw new Error('Authentication required.');
    }
    const res = db.prepare('DELETE FROM location_search_history WHERE user_id = ?').run(userId);
    this.invalidateUserCache(userId);
    return { success: true, clearedCount: Number(res.changes || 0) };
  },
};
