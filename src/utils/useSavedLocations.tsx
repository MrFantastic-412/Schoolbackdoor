import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { snapCoordsToArea } from '../data/locationAreas';
import type {
  CampusLocation,
  LocationSearchHistoryItem,
  SavedLocation,
} from '../types';

type OfflineQueueOp =
  | {
      opId: string;
      type: 'save';
      tempId: string;
      payload: {
        id?: string;
        landmarkId?: string;
        name: string;
        customLabel?: string;
        category?: CampusLocation['category'] | string;
        campusZone?: string;
        description?: string;
        address?: string;
        notes?: string;
        coordinates: [number, number];
        isOffCampus?: boolean;
        isPinned?: boolean;
        source?: SavedLocation['source'];
      };
    }
  | {
      opId: string;
      type: 'update';
      targetId: string;
      patch: {
        name?: string;
        customLabel?: string | null;
        notes?: string | null;
        category?: string;
        isOffCampus?: boolean;
        isPinned?: boolean;
        markUsed?: boolean;
      };
    }
  | {
      opId: string;
      type: 'delete';
      targetId: string;
    }
  | {
      opId: string;
      type: 'history_add';
      tempId: string;
      payload: {
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
      };
    }
  | {
      opId: string;
      type: 'history_delete';
      targetId: string;
    }
  | {
      opId: string;
      type: 'history_clear';
    };

export interface SaveLocationRequest {
  id?: string;
  landmarkId?: string;
  name: string;
  customLabel?: string;
  category?: CampusLocation['category'] | string;
  campusZone?: string;
  description?: string;
  address?: string;
  notes?: string;
  coordinates: [number, number];
  isOffCampus?: boolean;
  isPinned?: boolean;
  source?: SavedLocation['source'];
}

export interface UpdateSavedLocationRequest {
  name?: string;
  customLabel?: string | null;
  notes?: string | null;
  category?: string;
  isOffCampus?: boolean;
  isPinned?: boolean;
  markUsed?: boolean;
}

interface SavedLocationsContextValue {
  savedLocations: SavedLocation[];
  searchHistory: LocationSearchHistoryItem[];
  isLoading: boolean;
  isSyncing: boolean;
  isOnline: boolean;
  pendingCount: number;
  refreshLocations: () => Promise<void>;
  syncPendingChanges: () => Promise<void>;
  findMatchingSavedLocation: (loc?: {
    id?: string;
    landmarkId?: string;
    coordinates?: [number, number];
  } | null) => SavedLocation | undefined;
  saveLocation: (input: SaveLocationRequest, options?: { silent?: boolean }) => Promise<SavedLocation | null>;
  pinLocation: (
    loc: CampusLocation,
    source?: SavedLocation['source'],
    options?: { silent?: boolean; customLabel?: string; notes?: string }
  ) => Promise<SavedLocation | null>;
  updateSavedLocation: (id: string, patch: UpdateSavedLocationRequest) => Promise<SavedLocation | null>;
  togglePinLocation: (id: string) => Promise<SavedLocation | null>;
  removeSavedLocation: (id: string) => Promise<boolean>;
  recordSearch: (
    queryText: string,
    location?: {
      id?: string;
      name?: string;
      category?: string;
      campusZone?: string;
      description?: string;
      address?: string;
      coordinates?: [number, number];
      isOffCampus?: boolean;
    } | null
  ) => Promise<void>;
  removeSearchHistoryItem: (id: string) => Promise<void>;
  clearSearchHistory: () => Promise<void>;
}

const SavedLocationsContext = createContext<SavedLocationsContextValue | null>(null);

function cacheStorageKey(userId: string) {
  return `sb_saved_locs_v1_${userId}`;
}

function queueStorageKey(userId: string) {
  return `sb_saved_locs_queue_v1_${userId}`;
}

function readCachedState(userId: string): {
  savedLocations: SavedLocation[];
  searchHistory: LocationSearchHistoryItem[];
} {
  if (typeof window === 'undefined' || !userId) {
    return { savedLocations: [], searchHistory: [] };
  }
  try {
    const raw = localStorage.getItem(cacheStorageKey(userId));
    if (!raw) return { savedLocations: [], searchHistory: [] };
    const parsed = JSON.parse(raw);
    return {
      savedLocations: Array.isArray(parsed?.savedLocations) ? parsed.savedLocations : [],
      searchHistory: Array.isArray(parsed?.searchHistory) ? parsed.searchHistory : [],
    };
  } catch {
    return { savedLocations: [], searchHistory: [] };
  }
}

function writeCachedState(
  userId: string,
  savedLocations: SavedLocation[],
  searchHistory: LocationSearchHistoryItem[]
) {
  if (typeof window === 'undefined' || !userId) return;
  try {
    localStorage.setItem(
      cacheStorageKey(userId),
      JSON.stringify({ savedLocations, searchHistory, updatedAt: Date.now() })
    );
  } catch {
    // Ignore storage quota restrictions
  }
}

function readQueue(userId: string): OfflineQueueOp[] {
  if (typeof window === 'undefined' || !userId) return [];
  try {
    const raw = localStorage.getItem(queueStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(userId: string, queue: OfflineQueueOp[]) {
  if (typeof window === 'undefined' || !userId) return;
  try {
    if (queue.length === 0) {
      localStorage.removeItem(queueStorageKey(userId));
    } else {
      localStorage.setItem(queueStorageKey(userId), JSON.stringify(queue));
    }
  } catch {
    // Ignore storage quota restrictions
  }
}

function isKnownLandmarkId(rawId?: string): boolean {
  if (!rawId) return false;
  return (
    !rawId.startsWith('custom-') &&
    !rawId.startsWith('osm-') &&
    !rawId.startsWith('saved-') &&
    !rawId.startsWith('loc-') &&
    !rawId.startsWith('hist-') &&
    !rawId.startsWith('tmp-')
  );
}

function coordsMatch(a?: [number, number], b?: [number, number]): boolean {
  if (!a || !b) return false;
  return Number(a[0]).toFixed(4) === Number(b[0]).toFixed(4) && Number(a[1]).toFixed(4) === Number(b[1]).toFixed(4);
}

function sortSavedLocations(items: SavedLocation[]): SavedLocation[] {
  return [...items].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    const ta = new Date(a.lastUsedAt || a.updatedAt || a.createdAt).getTime();
    const tb = new Date(b.lastUsedAt || b.updatedAt || b.createdAt).getTime();
    return tb - ta;
  });
}

function isOfflineNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return (
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('load failed') ||
    msg.includes('offline')
  );
}

export const SavedLocationsProvider: React.FC<{
  userId?: string;
  onNotify?: (msg: string) => void;
  children: React.ReactNode;
}> = ({ userId, onNotify, children }) => {
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([]);
  const [searchHistory, setSearchHistory] = useState<LocationSearchHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  const syncingRef = useRef(false);
  const activeUserIdRef = useRef<string | undefined>(userId);
  activeUserIdRef.current = userId;

  const persistSnapshot = useCallback(
    (uid: string, nextSaved: SavedLocation[], nextHistory: LocationSearchHistoryItem[]) => {
      if (!uid || activeUserIdRef.current !== uid) return;
      const sorted = sortSavedLocations(nextSaved);
      setSavedLocations(sorted);
      setSearchHistory(nextHistory);
      writeCachedState(uid, sorted, nextHistory);
    },
    []
  );

  const enqueueOp = useCallback((uid: string, op: OfflineQueueOp) => {
    const current = readQueue(uid);
    const next = [...current, op];
    writeQueue(uid, next);
    if (activeUserIdRef.current === uid) {
      setPendingCount(next.length);
    }
  }, []);

  const syncPendingChanges = useCallback(async () => {
    const uid = activeUserIdRef.current;
    if (!uid || syncingRef.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    const queue = readQueue(uid);
    if (queue.length === 0) return;

    syncingRef.current = true;
    setIsSyncing(true);
    const tempToRealId = new Map<string, string>();
    const remaining: OfflineQueueOp[] = [];

    try {
      for (let i = 0; i < queue.length; i += 1) {
        const op = queue[i];
        try {
          if (op.type === 'save') {
            const created = await api.saveOrPinLocation(op.payload);
            tempToRealId.set(op.tempId, created.id);
          } else if (op.type === 'update') {
            const resolvedId = tempToRealId.get(op.targetId) || op.targetId;
            await api.updateSavedLocation(resolvedId, op.patch);
          } else if (op.type === 'delete') {
            const resolvedId = tempToRealId.get(op.targetId) || op.targetId;
            if (!resolvedId.startsWith('tmp-')) {
              await api.deleteSavedLocation(resolvedId).catch(() => null);
            }
          } else if (op.type === 'history_add') {
            await api.recordLocationSearch(op.payload);
          } else if (op.type === 'history_delete') {
            if (!op.targetId.startsWith('tmp-')) {
              await api.deleteLocationSearchHistoryItem(op.targetId).catch(() => null);
            }
          } else if (op.type === 'history_clear') {
            await api.clearLocationSearchHistory();
          }
        } catch (err) {
          if (isOfflineNetworkError(err)) {
            remaining.push(...queue.slice(i));
            break;
          }
          // Non-network server rejection: drop invalid op so queue does not wedge forever
        }
      }

      writeQueue(uid, remaining);
      if (activeUserIdRef.current === uid) {
        setPendingCount(remaining.length);
      }

      if (remaining.length === 0 && activeUserIdRef.current === uid) {
        const fresh = await api.getSavedLocationsAndHistory();
        persistSnapshot(uid, fresh.savedLocations, fresh.searchHistory);
      }
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
    }
  }, [persistSnapshot]);

  const refreshLocations = useCallback(async () => {
    const uid = activeUserIdRef.current;
    if (!uid) return;
    setIsLoading(true);
    try {
      if (readQueue(uid).length > 0 && (typeof navigator === 'undefined' || navigator.onLine)) {
        await syncPendingChanges();
      }
      const data = await api.getSavedLocationsAndHistory();
      if (activeUserIdRef.current === uid && readQueue(uid).length === 0) {
        persistSnapshot(uid, data.savedLocations, data.searchHistory);
      }
    } catch {
      // Fall back silently to per-user offline cache already hydrated
    } finally {
      setIsLoading(false);
    }
  }, [persistSnapshot, syncPendingChanges]);

  useEffect(() => {
    if (!userId) {
      setSavedLocations([]);
      setSearchHistory([]);
      setPendingCount(0);
      setIsLoading(false);
      return;
    }

    const cached = readCachedState(userId);
    const queued = readQueue(userId);
    setSavedLocations(sortSavedLocations(cached.savedLocations));
    setSearchHistory(cached.searchHistory);
    setPendingCount(queued.length);

    void refreshLocations();
  }, [userId, refreshLocations]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      void syncPendingChanges();
    };
    const handleOffline = () => {
      setIsOnline(false);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [syncPendingChanges]);

  const findMatchingSavedLocation = useCallback(
    (loc?: { id?: string; landmarkId?: string; coordinates?: [number, number] } | null) => {
      if (!loc) return undefined;
      return savedLocations.find((item) => {
        if (loc.id && item.id === loc.id) return true;
        const candidateLandmarkId = loc.landmarkId || (isKnownLandmarkId(loc.id) ? loc.id : undefined);
        if (candidateLandmarkId && item.landmarkId === candidateLandmarkId) return true;
        if (loc.coordinates && coordsMatch(item.coordinates, loc.coordinates)) return true;
        return false;
      });
    },
    [savedLocations]
  );

  const saveLocation = useCallback(
    async (input: SaveLocationRequest, options?: { silent?: boolean }): Promise<SavedLocation | null> => {
      const uid = activeUserIdRef.current;
      if (!uid) return null;

      const snapped = snapCoordsToArea(input.coordinates[0], input.coordinates[1]);
      const nowIso = new Date().toISOString();
      const landmarkId =
        input.landmarkId || (isKnownLandmarkId(input.id) ? input.id : undefined);

      const existing = findMatchingSavedLocation({
        id: input.id,
        landmarkId,
        coordinates: input.coordinates,
      });

      const optimisticId = existing?.id || `tmp-loc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const optimisticRecord: SavedLocation = {
        id: optimisticId,
        userId: uid,
        landmarkId: landmarkId || existing?.landmarkId,
        name: existing?.name || input.name,
        customLabel: input.customLabel ?? existing?.customLabel,
        displayName: input.customLabel || existing?.customLabel || existing?.name || input.name,
        category: ((input.category as CampusLocation['category']) || existing?.category || 'custom'),
        areaKey: existing?.areaKey || snapped?.key,
        areaLabel: existing?.areaLabel || snapped?.shortLabel,
        campusZone: input.campusZone || existing?.campusZone || snapped?.label,
        description: input.description || existing?.description,
        address: input.address || existing?.address,
        notes: input.notes ?? existing?.notes,
        coordinates: input.coordinates,
        isOffCampus:
          typeof input.isOffCampus === 'boolean'
            ? input.isOffCampus
            : existing?.isOffCampus ?? Boolean(snapped?.isOffCampus),
        isPinned: Boolean(input.isPinned || existing?.isPinned),
        source: input.source || existing?.source || 'manual',
        lastUsedAt: nowIso,
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso,
      };

      const nextList = existing
        ? savedLocations.map((item) => (item.id === existing.id ? optimisticRecord : item))
        : [optimisticRecord, ...savedLocations];
      persistSnapshot(uid, nextList, searchHistory);

      try {
        const saved = await api.saveOrPinLocation(input);
        if (activeUserIdRef.current === uid) {
          setSavedLocations((prev) => {
            const without = prev.filter((item) => item.id !== optimisticId && item.id !== saved.id);
            const updated = sortSavedLocations([saved, ...without]);
            writeCachedState(uid, updated, searchHistory);
            return updated;
          });
        }
        if (!options?.silent && onNotify) {
          onNotify(
            saved.isPinned
              ? `Pinned & saved "${saved.displayName}".`
              : `Saved "${saved.displayName}" to your locations.`
          );
        }
        return saved;
      } catch (err) {
        if (isOfflineNetworkError(err)) {
          const offlineVersion: SavedLocation = { ...optimisticRecord, pendingSync: true };
          setSavedLocations((prev) => {
            const updated = sortSavedLocations(
              prev.map((item) => (item.id === optimisticId ? offlineVersion : item))
            );
            writeCachedState(uid, updated, searchHistory);
            return updated;
          });
          enqueueOp(uid, {
            opId: `op-${Date.now()}`,
            type: 'save',
            tempId: optimisticId,
            payload: input,
          });
          if (!options?.silent && onNotify) {
            onNotify('Offline mode: location saved locally and queued for sync.');
          }
          return offlineVersion;
        }
        // Revert optimistic update on validation/auth error
        persistSnapshot(uid, savedLocations, searchHistory);
        if (onNotify && err instanceof Error) {
          onNotify(err.message);
        }
        return null;
      }
    },
    [enqueueOp, findMatchingSavedLocation, onNotify, persistSnapshot, savedLocations, searchHistory]
  );

  const pinLocation = useCallback(
    async (
      loc: CampusLocation,
      source: SavedLocation['source'] = 'manual',
      options?: { silent?: boolean; customLabel?: string; notes?: string }
    ): Promise<SavedLocation | null> => {
      return saveLocation(
        {
          id: loc.id,
          landmarkId: isKnownLandmarkId(loc.id) ? loc.id : undefined,
          name: loc.name,
          customLabel: options?.customLabel,
          category: loc.category,
          description: loc.description,
          address: loc.address,
          notes: options?.notes,
          coordinates: loc.coordinates,
          isOffCampus: loc.isOffCampus,
          isPinned: true,
          source,
        },
        options
      );
    },
    [saveLocation]
  );

  const updateSavedLocation = useCallback(
    async (id: string, patch: UpdateSavedLocationRequest): Promise<SavedLocation | null> => {
      const uid = activeUserIdRef.current;
      if (!uid) return null;
      const target = savedLocations.find((item) => item.id === id);
      if (!target) return null;

      const nextName = patch.name !== undefined && patch.name.trim() ? patch.name.trim() : target.name;
      const nextCustomLabel =
        patch.customLabel === null
          ? undefined
          : patch.customLabel !== undefined
          ? patch.customLabel.trim() || undefined
          : target.customLabel;
      const nextNotes =
        patch.notes === null
          ? undefined
          : patch.notes !== undefined
          ? patch.notes.trim() || undefined
          : target.notes;

      const optimistic: SavedLocation = {
        ...target,
        name: nextName,
        customLabel: nextCustomLabel,
        displayName: nextCustomLabel || nextName,
        notes: nextNotes,
        category: (patch.category as CampusLocation['category']) || target.category,
        isOffCampus: patch.isOffCampus !== undefined ? patch.isOffCampus : target.isOffCampus,
        isPinned: patch.isPinned !== undefined ? patch.isPinned : target.isPinned,
        lastUsedAt: patch.markUsed ? new Date().toISOString() : target.lastUsedAt,
        updatedAt: new Date().toISOString(),
      };

      const nextList = savedLocations.map((item) => (item.id === id ? optimistic : item));
      persistSnapshot(uid, nextList, searchHistory);

      if (id.startsWith('tmp-loc-')) {
        enqueueOp(uid, { opId: `op-${Date.now()}`, type: 'update', targetId: id, patch });
        return optimistic;
      }

      try {
        const updated = await api.updateSavedLocation(id, patch);
        if (activeUserIdRef.current === uid) {
          setSavedLocations((prev) => {
            const merged = sortSavedLocations(prev.map((item) => (item.id === id ? updated : item)));
            writeCachedState(uid, merged, searchHistory);
            return merged;
          });
        }
        return updated;
      } catch (err) {
        if (isOfflineNetworkError(err)) {
          const offlineItem = { ...optimistic, pendingSync: true };
          setSavedLocations((prev) => {
            const merged = sortSavedLocations(prev.map((item) => (item.id === id ? offlineItem : item)));
            writeCachedState(uid, merged, searchHistory);
            return merged;
          });
          enqueueOp(uid, { opId: `op-${Date.now()}`, type: 'update', targetId: id, patch });
          onNotify?.('Offline mode: location changes queued to sync.');
          return offlineItem;
        }
        persistSnapshot(uid, savedLocations, searchHistory);
        if (onNotify && err instanceof Error) onNotify(err.message);
        return null;
      }
    },
    [enqueueOp, onNotify, persistSnapshot, savedLocations, searchHistory]
  );

  const togglePinLocation = useCallback(
    async (id: string) => {
      const target = savedLocations.find((item) => item.id === id);
      if (!target) return null;
      const updated = await updateSavedLocation(id, { isPinned: !target.isPinned });
      if (updated && onNotify) {
        onNotify(
          updated.isPinned
            ? `Pinned "${updated.displayName}".`
            : `Unpinned "${updated.displayName}" (still in Saved Locations).`
        );
      }
      return updated;
    },
    [onNotify, savedLocations, updateSavedLocation]
  );

  const removeSavedLocation = useCallback(
    async (id: string): Promise<boolean> => {
      const uid = activeUserIdRef.current;
      if (!uid) return false;
      const previous = savedLocations;
      const next = savedLocations.filter((item) => item.id !== id);
      persistSnapshot(uid, next, searchHistory);

      if (id.startsWith('tmp-loc-')) {
        const filteredQueue = readQueue(uid).filter(
          (op) => !(op.type === 'save' && op.tempId === id) && !('targetId' in op && op.targetId === id)
        );
        writeQueue(uid, filteredQueue);
        setPendingCount(filteredQueue.length);
        return true;
      }

      try {
        await api.deleteSavedLocation(id);
        onNotify?.('Location removed from saved spots.');
        return true;
      } catch (err) {
        if (isOfflineNetworkError(err)) {
          enqueueOp(uid, { opId: `op-${Date.now()}`, type: 'delete', targetId: id });
          onNotify?.('Offline mode: removal queued for sync.');
          return true;
        }
        persistSnapshot(uid, previous, searchHistory);
        if (onNotify && err instanceof Error) onNotify(err.message);
        return false;
      }
    },
    [enqueueOp, onNotify, persistSnapshot, savedLocations, searchHistory]
  );

  const recordSearch = useCallback(
    async (
      queryText: string,
      location?: {
        id?: string;
        name?: string;
        category?: string;
        campusZone?: string;
        description?: string;
        address?: string;
        coordinates?: [number, number];
        isOffCampus?: boolean;
      } | null
    ) => {
      const uid = activeUserIdRef.current;
      const trimmed = queryText.trim();
      if (!uid || (!trimmed && !location?.name)) return;

      const tempId = `tmp-hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const snapped = location?.coordinates
        ? snapCoordsToArea(location.coordinates[0], location.coordinates[1])
        : null;

      const optimisticEntry: LocationSearchHistoryItem = {
        id: tempId,
        userId: uid,
        queryText: trimmed || location?.name || '',
        selectedName: location?.name,
        selectedDescription: location?.description,
        selectedAddress: location?.address,
        selectedCategory: location?.category,
        areaKey: snapped?.key,
        areaLabel: snapped?.shortLabel,
        coordinates: location?.coordinates,
        isOffCampus: Boolean(location?.isOffCampus ?? snapped?.isOffCampus),
        landmarkId: isKnownLandmarkId(location?.id) ? location?.id : undefined,
        searchCount: 1,
        searchedAt: new Date().toISOString(),
      };

      setSearchHistory((prev) => {
        const deduped = prev.filter((item) => {
          if (location?.coordinates && item.coordinates && coordsMatch(item.coordinates, location.coordinates)) {
            return false;
          }
          if (!location?.coordinates && !item.coordinates && item.queryText.toLowerCase() === optimisticEntry.queryText.toLowerCase()) {
            return false;
          }
          return true;
        });
        const next = [optimisticEntry, ...deduped].slice(0, 50);
        writeCachedState(uid, savedLocations, next);
        return next;
      });

      try {
        const created = await api.recordLocationSearch({ queryText: trimmed || location?.name || '', location });
        if (activeUserIdRef.current === uid) {
          setSearchHistory((prev) => {
            const cleaned = prev.filter((item) => item.id !== tempId && item.id !== created.id);
            const next = [created, ...cleaned].slice(0, 50);
            writeCachedState(uid, savedLocations, next);
            return next;
          });
        }
      } catch (err) {
        if (isOfflineNetworkError(err)) {
          enqueueOp(uid, {
            opId: `op-${Date.now()}`,
            type: 'history_add',
            tempId,
            payload: { queryText: trimmed || location?.name || '', location },
          });
        }
      }
    },
    [enqueueOp, savedLocations]
  );

  const removeSearchHistoryItem = useCallback(
    async (id: string) => {
      const uid = activeUserIdRef.current;
      if (!uid) return;
      const prev = searchHistory;
      const next = searchHistory.filter((item) => item.id !== id);
      persistSnapshot(uid, savedLocations, next);

      if (id.startsWith('tmp-hist-')) return;

      try {
        await api.deleteLocationSearchHistoryItem(id);
      } catch (err) {
        if (isOfflineNetworkError(err)) {
          enqueueOp(uid, { opId: `op-${Date.now()}`, type: 'history_delete', targetId: id });
          return;
        }
        persistSnapshot(uid, savedLocations, prev);
      }
    },
    [enqueueOp, persistSnapshot, savedLocations, searchHistory]
  );

  const clearSearchHistory = useCallback(async () => {
    const uid = activeUserIdRef.current;
    if (!uid) return;
    const prev = searchHistory;
    persistSnapshot(uid, savedLocations, []);

    try {
      await api.clearLocationSearchHistory();
      onNotify?.('Cleared recent location search history.');
    } catch (err) {
      if (isOfflineNetworkError(err)) {
        enqueueOp(uid, { opId: `op-${Date.now()}`, type: 'history_clear' });
        return;
      }
      persistSnapshot(uid, savedLocations, prev);
    }
  }, [enqueueOp, onNotify, persistSnapshot, savedLocations, searchHistory]);

  return (
    <SavedLocationsContext.Provider
      value={{
        savedLocations,
        searchHistory,
        isLoading,
        isSyncing,
        isOnline,
        pendingCount,
        refreshLocations,
        syncPendingChanges,
        findMatchingSavedLocation,
        saveLocation,
        pinLocation,
        updateSavedLocation,
        togglePinLocation,
        removeSavedLocation,
        recordSearch,
        removeSearchHistoryItem,
        clearSearchHistory,
      }}
    >
      {children}
    </SavedLocationsContext.Provider>
  );
};

export function useSavedLocations(): SavedLocationsContextValue {
  const ctx = useContext(SavedLocationsContext);
  if (!ctx) {
    return {
      savedLocations: [],
      searchHistory: [],
      isLoading: false,
      isSyncing: false,
      isOnline: true,
      pendingCount: 0,
      refreshLocations: async () => {},
      syncPendingChanges: async () => {},
      findMatchingSavedLocation: () => undefined,
      saveLocation: async () => null,
      pinLocation: async () => null,
      updateSavedLocation: async () => null,
      togglePinLocation: async () => null,
      removeSavedLocation: async () => false,
      recordSearch: async () => {},
      removeSearchHistoryItem: async () => {},
      clearSearchHistory: async () => {},
    };
  }
  return ctx;
}
