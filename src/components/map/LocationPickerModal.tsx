import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Check,
  Clock,
  Compass,
  Edit2,
  Globe,
  History,
  Loader2,
  MapPin,
  Pin,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { FUTA_CAMPUS_SPOTS } from '../../data/futaData';
import { CampusLocation, SavedLocation } from '../../types';
import { reverseGeocode, searchNominatim } from '../../utils/navigation';
import { useSavedLocations } from '../../utils/useSavedLocations';
import { LazyLeafletMap } from './LazyLeafletMap';
import { GlassButton, GlassModal } from '../glass';
import { triggerHaptic } from '../../utils/haptics';

interface LocationPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectLocation: (loc: CampusLocation | null) => void;
  currentLocation?: CampusLocation | null;
}

type PickerFilter = 'all' | 'pinned' | 'saved' | 'recent' | 'campus' | 'off_campus' | 'hostel';

export const LocationPickerModal: React.FC<LocationPickerModalProps> = ({
  isOpen,
  onClose,
  onSelectLocation,
  currentLocation,
}) => {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<PickerFilter>('all');
  const [selectedSpot, setSelectedSpot] = useState<CampusLocation | null>(
    currentLocation || FUTA_CAMPUS_SPOTS[0]
  );
  const [customSpotName, setCustomSpotName] = useState('');
  const [isSearchingOnline, setIsSearchingOnline] = useState(false);
  const [onlineResults, setOnlineResults] = useState<CampusLocation[]>([]);
  const [isReverseGeocoding, setIsReverseGeocoding] = useState(false);

  const lastRecordedQueryRef = useRef('');

  const {
    savedLocations,
    searchHistory,
    findMatchingSavedLocation,
    saveLocation,
    pinLocation,
    togglePinLocation,
    removeSavedLocation,
    recordSearch,
    removeSearchHistoryItem,
    clearSearchHistory,
  } = useSavedLocations();

  useEffect(() => {
    if (isOpen) {
      if (currentLocation) {
        setSelectedSpot(currentLocation);
        setCustomSpotName(currentLocation.name);
      } else if (!selectedSpot) {
        setSelectedSpot(FUTA_CAMPUS_SPOTS[0]);
      }
    }
  }, [isOpen, currentLocation]);

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed.length < 3) {
      setOnlineResults([]);
      setIsSearchingOnline(false);
      return;
    }

    setIsSearchingOnline(true);
    const timeout = setTimeout(async () => {
      const results = await searchNominatim(trimmed);
      setOnlineResults(results);
      setIsSearchingOnline(false);

      if (trimmed !== lastRecordedQueryRef.current) {
        lastRecordedQueryRef.current = trimmed;
        void recordSearch(trimmed, results[0] || null);
      }
    }, 480);

    return () => clearTimeout(timeout);
  }, [search, recordSearch]);

  const savedAsLocations = useMemo<CampusLocation[]>(() => {
    return savedLocations.map((s) => ({
      id: s.landmarkId || s.id,
      name: s.displayName,
      category: s.category,
      coordinates: s.coordinates,
      description: s.notes || s.description || s.address || s.areaLabel || 'Saved spot',
      address: s.address,
      isOffCampus: s.isOffCampus,
    }));
  }, [savedLocations]);

  const mapMarkers = useMemo(() => {
    const combined = new Map<
      string,
      {
        id: string;
        name: string;
        coordinates: [number, number];
        category?: string;
        description?: string;
        pinVariant?: 'default' | 'saved' | 'pinned';
      }
    >();

    FUTA_CAMPUS_SPOTS.forEach((spot) => {
      const coordKey = `${spot.coordinates[0].toFixed(4)},${spot.coordinates[1].toFixed(4)}`;
      const savedMatch = findMatchingSavedLocation(spot);
      combined.set(coordKey, {
        ...spot,
        name: savedMatch ? savedMatch.displayName : spot.name,
        pinVariant: savedMatch ? (savedMatch.isPinned ? 'pinned' : 'saved') : 'default',
      });
    });

    savedLocations.forEach((item) => {
      const coordKey = `${item.coordinates[0].toFixed(4)},${item.coordinates[1].toFixed(4)}`;
      if (!combined.has(coordKey)) {
        combined.set(coordKey, {
          id: item.id,
          name: item.displayName,
          coordinates: item.coordinates,
          category: item.category,
          description: item.notes || item.description || item.address || item.areaLabel,
          pinVariant: item.isPinned ? 'pinned' : 'saved',
        });
      }
    });

    return Array.from(combined.values());
  }, [savedLocations, findMatchingSavedLocation]);

  if (!isOpen) return null;

  const q = search.trim().toLowerCase();

  const filteredSavedLocations = savedLocations.filter((item) => {
    if (categoryFilter === 'pinned' && !item.isPinned) return false;
    if (categoryFilter === 'campus' && item.isOffCampus) return false;
    if (categoryFilter === 'off_campus' && !item.isOffCampus && item.category !== 'off_campus') return false;
    if (categoryFilter === 'hostel' && item.category !== 'hostel') return false;
    if (!q) return true;
    return (
      item.displayName.toLowerCase().includes(q) ||
      item.name.toLowerCase().includes(q) ||
      item.description?.toLowerCase().includes(q) ||
      item.address?.toLowerCase().includes(q) ||
      item.notes?.toLowerCase().includes(q) ||
      item.areaLabel?.toLowerCase().includes(q)
    );
  });

  const filteredHistory = searchHistory.filter((item) => {
    if (!q) return true;
    return (
      item.queryText.toLowerCase().includes(q) ||
      item.selectedName?.toLowerCase().includes(q) ||
      item.selectedAddress?.toLowerCase().includes(q)
    );
  });

  const filteredLocalSpots = FUTA_CAMPUS_SPOTS.filter((spot) => {
    if (categoryFilter === 'pinned' || categoryFilter === 'saved' || categoryFilter === 'recent') {
      return false;
    }
    if (categoryFilter === 'campus' && spot.isOffCampus) return false;
    if (categoryFilter === 'off_campus' && !spot.isOffCampus && spot.category !== 'off_campus') return false;
    if (categoryFilter === 'hostel' && spot.category !== 'hostel') return false;

    if (!q) return true;
    return (
      spot.name.toLowerCase().includes(q) ||
      spot.description?.toLowerCase().includes(q) ||
      spot.category.toLowerCase().includes(q)
    );
  });

  const handleSelectSpotItem = (spot: CampusLocation, fromSearch = false) => {
    triggerHaptic('tap');
    setSelectedSpot(spot);
    setCustomSpotName(spot.name);
    if (fromSearch || search.trim().length >= 2) {
      void recordSearch(search.trim() || spot.name, spot);
    }
  };

  const handleSelectSavedItem = (saved: SavedLocation) => {
    triggerHaptic('tap');
    const loc: CampusLocation = {
      id: saved.landmarkId || saved.id,
      name: saved.displayName,
      category: saved.category,
      coordinates: saved.coordinates,
      description: saved.notes || saved.description || saved.address || saved.areaLabel,
      address: saved.address,
      isOffCampus: saved.isOffCampus,
    };
    setSelectedSpot(loc);
    setCustomSpotName(saved.displayName);
  };

  const handleSelectHistoryItem = (item: typeof searchHistory[number]) => {
    triggerHaptic('tap');
    if (item.coordinates) {
      const loc: CampusLocation = {
        id: item.landmarkId || item.id,
        name: item.selectedName || item.queryText,
        category: (item.selectedCategory as CampusLocation['category']) || 'off_campus',
        coordinates: item.coordinates,
        description: item.selectedDescription || item.selectedAddress || `Searched "${item.queryText}"`,
        address: item.selectedAddress,
        isOffCampus: item.isOffCampus,
      };
      setSelectedSpot(loc);
      setCustomSpotName(loc.name);
      void recordSearch(item.queryText, loc);
    } else {
      setSearch(item.queryText);
      if (categoryFilter === 'recent') {
        setCategoryFilter('all');
      }
    }
  };

  const handleMapClick = async (coords: [number, number]) => {
    triggerHaptic('tap');
    const nearbySaved = savedLocations.find(
      (s) =>
        Math.abs(s.coordinates[0] - coords[0]) < 0.0006 &&
        Math.abs(s.coordinates[1] - coords[1]) < 0.0006
    );
    if (nearbySaved) {
      handleSelectSavedItem(nearbySaved);
      return;
    }

    const nearby = FUTA_CAMPUS_SPOTS.find(
      (s) =>
        Math.abs(s.coordinates[0] - coords[0]) < 0.0008 &&
        Math.abs(s.coordinates[1] - coords[1]) < 0.0008
    );

    if (nearby) {
      setSelectedSpot(nearby);
      setCustomSpotName(nearby.name);
      return;
    }

    const isWithinCampusBounds =
      coords[0] >= 7.297 && coords[0] <= 7.312 && coords[1] >= 5.132 && coords[1] <= 5.143;

    const initialCustomLoc: CampusLocation = {
      id: `custom-${Date.now()}`,
      name: `Custom Point (${coords[0].toFixed(4)}, ${coords[1].toFixed(4)})`,
      category: isWithinCampusBounds ? 'custom' : 'off_campus',
      coordinates: coords,
      description: isWithinCampusBounds
        ? 'Custom spot inside Obanla campus'
        : 'Off-campus spot in surrounding Akure area',
      isOffCampus: !isWithinCampusBounds,
    };

    setSelectedSpot(initialCustomLoc);
    setCustomSpotName(initialCustomLoc.name);

    setIsReverseGeocoding(true);
    const geocoded = await reverseGeocode(coords[0], coords[1]);
    setIsReverseGeocoding(false);

    if (geocoded) {
      setSelectedSpot((prev) => {
        if (!prev || prev.id !== initialCustomLoc.id) return prev;
        return {
          ...prev,
          name: geocoded.name,
          address: geocoded.address,
          description: geocoded.address,
        };
      });
      setCustomSpotName(geocoded.name);
    }
  };

  const handleConfirm = () => {
    if (!selectedSpot) return;
    triggerHaptic('success');
    const finalName = customSpotName.trim() || selectedSpot.name;
    const finalized: CampusLocation = {
      ...selectedSpot,
      name: finalName,
    };
    void pinLocation(finalized, 'map', { silent: true });
    onSelectLocation(finalized);
    onClose();
  };

  const handleRemove = () => {
    triggerHaptic('tap');
    onSelectLocation(null);
    onClose();
  };

  const selectedSavedMatch = findMatchingSavedLocation(selectedSpot);

  return (
    <GlassModal
      isOpen={isOpen}
      onClose={onClose}
      title="Pin Location or Campus Spot"
      subtitle="Search, revisit history, or pick a saved spot on campus or off-campus"
      maxWidthClass="max-w-2xl"
    >
      <div className="flex flex-col">
        <div className="p-3.5 sm:p-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 text-xs text-[#82796F] dark:text-[#A89F95] flex-wrap">
              <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
                <span>Interactive Campus &amp; Off-Campus Map</span>
              </span>
              <span className="text-[11px] font-mono">
                {isReverseGeocoding ? 'Detecting address...' : 'Tap anywhere to drop pin'}
              </span>
            </div>

            <LazyLeafletMap
              center={selectedSpot ? selectedSpot.coordinates : [7.3034, 5.1386]}
              zoom={selectedSpot?.isOffCampus ? 15 : 16}
              markers={mapMarkers}
              selectedCoordinates={selectedSpot ? selectedSpot.coordinates : null}
              selectedLabel={customSpotName || selectedSpot?.name}
              onSelectCoordinates={handleMapClick}
              height="200px"
            />
          </div>

          {selectedSpot && (
            <div className="p-3 glass-subtle rounded-2xl flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div className="w-8 h-8 rounded-lg bg-[#D98BA5] text-[#171613] flex items-center justify-center shrink-0">
                    <MapPin className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-[10px] uppercase font-mono tracking-wider text-[#82796F] dark:text-[#A89F95]">
                      {selectedSavedMatch?.isPinned
                        ? 'Pinned Saved Location'
                        : selectedSavedMatch
                        ? 'Saved Location'
                        : selectedSpot.isOffCampus
                        ? 'Off-Campus Location'
                        : 'On-Campus Spot'}
                    </span>
                    <span className="text-xs font-bold text-[#171613] dark:text-[#F5EFE3] truncate">
                      {customSpotName || selectedSpot.name}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      if (selectedSavedMatch) {
                        void removeSavedLocation(selectedSavedMatch.id);
                      } else {
                        void saveLocation({
                          id: selectedSpot.id,
                          name: customSpotName.trim() || selectedSpot.name,
                          category: selectedSpot.category,
                          description: selectedSpot.description,
                          address: selectedSpot.address,
                          coordinates: selectedSpot.coordinates,
                          isOffCampus: selectedSpot.isOffCampus,
                          isPinned: false,
                          source: onlineResults.some((r) => r.id === selectedSpot.id) ? 'search' : 'map',
                        });
                      }
                    }}
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer min-h-[34px] ${
                      selectedSavedMatch
                        ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] border-[#171613] dark:border-[#F5EFE3]'
                        : 'glass-cream text-[#171613] dark:text-[#F5EFE3] border-[#171613]/15 dark:border-white/15 hover:bg-[#F6E2E6]'
                    }`}
                  >
                    <Bookmark className={`w-3 h-3 ${selectedSavedMatch ? 'fill-current text-[#D98BA5]' : ''}`} />
                    <span>{selectedSavedMatch ? 'Saved' : 'Save Spot'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('success');
                      if (selectedSavedMatch) {
                        void togglePinLocation(selectedSavedMatch.id);
                      } else {
                        void pinLocation(
                          {
                            ...selectedSpot,
                            name: customSpotName.trim() || selectedSpot.name,
                          },
                          onlineResults.some((r) => r.id === selectedSpot.id) ? 'search' : 'map'
                        );
                      }
                    }}
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer min-h-[34px] ${
                      selectedSavedMatch?.isPinned
                        ? 'glass-pink text-[#171613] border-[#C4718E]/40'
                        : 'glass-cream text-[#171613] dark:text-[#F5EFE3] border-[#171613]/15 dark:border-white/15 hover:bg-[#F6E2E6]'
                    }`}
                  >
                    <Pin className={`w-3 h-3 ${selectedSavedMatch?.isPinned ? 'fill-current' : ''}`} />
                    <span>{selectedSavedMatch?.isPinned ? 'Pinned' : 'Pin Spot'}</span>
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1.5 border-t border-[#171613]/10 dark:border-white/10">
                <label className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95] shrink-0 flex items-center gap-1">
                  <Edit2 className="w-3 h-3 text-[#C4718E] dark:text-[#E5A4BA]" />
                  <span>Spot Label:</span>
                </label>
                <input
                  type="text"
                  value={customSpotName}
                  onChange={(e) => setCustomSpotName(e.target.value)}
                  placeholder="Stateline Lodge, Room 12, South Gate..."
                  className="flex-1 min-w-0 glass-input rounded-lg px-2.5 py-1.5 text-xs text-[#171613] dark:text-[#F5EFE3]"
                />
              </div>

              {selectedSpot.address && (
                <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] truncate">
                  {selectedSpot.address}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2 pt-1">
            <div className="flex flex-col gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#82796F] dark:text-[#A89F95] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search saved spots, hostels, streets (Apatapiti, Stateline, SEET)..."
                  className="w-full pl-8 pr-8 py-2 glass-input rounded-xl text-xs text-[#171613] dark:text-[#F5EFE3]"
                />
                {isSearchingOnline ? (
                  <Loader2 className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA] animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
                ) : search ? (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label="Clear location search"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#82796F] hover:text-[#171613] dark:hover:text-[#F5EFE3] p-1 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                ) : null}
              </div>

              <div className="flex items-center gap-1 overflow-x-auto text-[11px] scrollbar-none pb-0.5">
                {(
                  [
                    { id: 'all', label: 'All' },
                    { id: 'pinned', label: `Pinned (${savedLocations.filter((s) => s.isPinned).length})` },
                    { id: 'saved', label: `Saved (${savedLocations.length})` },
                    { id: 'recent', label: `Recent (${searchHistory.length})` },
                    { id: 'campus', label: 'On Campus' },
                    { id: 'off_campus', label: 'Off-Campus' },
                    { id: 'hostel', label: 'Hostels' },
                  ] as Array<{ id: PickerFilter; label: string }>
                ).map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setCategoryFilter(cat.id);
                    }}
                    className={`px-2.5 py-1.5 min-h-[34px] rounded-xl transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      categoryFilter === cat.id
                        ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] font-medium'
                        : 'glass-subtle text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-52 overflow-y-auto pr-1">
              {/* Saved & Pinned Locations in Pinned/Saved tabs or matching All search */}
              {(categoryFilter === 'pinned' ||
                categoryFilter === 'saved' ||
                (categoryFilter === 'all' && filteredSavedLocations.length > 0)) && (
                <>
                  <div className="col-span-full pb-0.5 text-[10px] font-mono text-[#C4718E] dark:text-[#E5A4BA] uppercase tracking-wider flex items-center gap-1">
                    <Bookmark className="w-3 h-3" />
                    <span>
                      {categoryFilter === 'pinned' ? 'Your Pinned Locations' : 'Saved & Pinned Locations'}
                    </span>
                  </div>
                  {filteredSavedLocations.length === 0 ? (
                    <div className="col-span-full py-4 text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                      No saved spots match your filter yet. Tap any spot on the map or search to save one.
                    </div>
                  ) : (
                    filteredSavedLocations.map((saved) => {
                      const isSelected =
                        selectedSpot?.coordinates[0] === saved.coordinates[0] &&
                        selectedSpot?.coordinates[1] === saved.coordinates[1];
                      return (
                        <div
                          key={saved.id}
                          className={`flex items-start gap-2 p-2.5 rounded-xl border text-left transition-all ${
                            isSelected
                              ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] border-[#171613] dark:border-[#F5EFE3] shadow-xs'
                              : 'glass-pink-tint text-[#171613] dark:text-[#F5EFE3]'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => handleSelectSavedItem(saved)}
                            className="flex items-start gap-2 flex-1 min-w-0 text-left cursor-pointer"
                          >
                            {saved.isPinned ? (
                              <Pin className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#D98BA5] fill-current" />
                            ) : (
                              <Bookmark className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#C4718E]" />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-semibold truncate">{saved.displayName}</span>
                                <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-[#D98BA5]/20 text-[#C4718E] dark:text-[#E5A4BA] shrink-0">
                                  {saved.isPinned ? 'Pinned' : 'Saved'}
                                </span>
                              </div>
                              <p
                                className={`text-[11px] truncate mt-0.5 ${
                                  isSelected
                                    ? 'text-[#F5EFE3]/75 dark:text-[#171613]/75'
                                    : 'text-[#82796F] dark:text-[#A89F95]'
                                }`}
                              >
                                {saved.notes || saved.areaLabel || saved.description || saved.address || 'Saved spot'}
                              </p>
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => void togglePinLocation(saved.id)}
                            title={saved.isPinned ? 'Unpin location' : 'Pin location'}
                            className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 shrink-0 cursor-pointer"
                          >
                            <Pin className={`w-3.5 h-3.5 ${saved.isPinned ? 'fill-current text-[#D98BA5]' : ''}`} />
                          </button>
                        </div>
                      );
                    })
                  )}
                </>
              )}

              {/* Recent Searches */}
              {(categoryFilter === 'recent' ||
                (categoryFilter === 'all' && !search.trim() && filteredHistory.length > 0)) && (
                <>
                  <div className="col-span-full pt-1 pb-0.5 flex items-center justify-between text-[10px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
                    <span className="flex items-center gap-1">
                      <History className="w-3 h-3 text-[#C4718E] dark:text-[#E5A4BA]" />
                      <span>Recent Searches</span>
                    </span>
                    {searchHistory.length > 0 && (
                      <button
                        type="button"
                        onClick={() => void clearSearchHistory()}
                        className="text-[10px] text-[#C4718E] hover:underline cursor-pointer"
                      >
                        Clear History
                      </button>
                    )}
                  </div>
                  {filteredHistory.length === 0 ? (
                    <div className="col-span-full py-4 text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                      No location searches recorded yet.
                    </div>
                  ) : (
                    filteredHistory.slice(0, categoryFilter === 'recent' ? 20 : 4).map((hist) => {
                      const savedFromHist = hist.coordinates
                        ? findMatchingSavedLocation({ coordinates: hist.coordinates, landmarkId: hist.landmarkId })
                        : undefined;
                      return (
                        <div
                          key={hist.id}
                          className="flex items-center gap-2 p-2 rounded-xl glass-subtle text-[#171613] dark:text-[#F5EFE3]"
                        >
                          <button
                            type="button"
                            onClick={() => handleSelectHistoryItem(hist)}
                            className="flex items-start gap-2 flex-1 min-w-0 text-left cursor-pointer"
                          >
                            <Clock className="w-3.5 h-3.5 text-[#82796F] shrink-0 mt-0.5" />
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-semibold truncate">
                                {hist.selectedName || hist.queryText}
                              </div>
                              <div className="text-[10px] text-[#82796F] dark:text-[#A89F95] truncate">
                                {hist.selectedAddress || hist.areaLabel || `Searched "${hist.queryText}"`}
                              </div>
                            </div>
                          </button>

                          {hist.coordinates && (
                            <button
                              type="button"
                              onClick={() => {
                                if (savedFromHist) {
                                  void removeSavedLocation(savedFromHist.id);
                                } else {
                                  void saveLocation({
                                    landmarkId: hist.landmarkId,
                                    name: hist.selectedName || hist.queryText,
                                    category: hist.selectedCategory || 'off_campus',
                                    description: hist.selectedDescription,
                                    address: hist.selectedAddress,
                                    coordinates: hist.coordinates!,
                                    isOffCampus: hist.isOffCampus,
                                    source: 'search',
                                  });
                                }
                              }}
                              title={savedFromHist ? 'Saved' : 'Save searched location'}
                              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 shrink-0 cursor-pointer"
                            >
                              <Bookmark
                                className={`w-3.5 h-3.5 ${
                                  savedFromHist ? 'fill-current text-[#C4718E]' : 'text-[#82796F]'
                                }`}
                              />
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => void removeSearchHistoryItem(hist.id)}
                            title="Remove from history"
                            className="p-1 rounded-lg text-[#82796F] hover:text-[#171613] dark:hover:text-[#F5EFE3] shrink-0 cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </>
              )}

              {/* Nominatim Search Results with Inline Save */}
              {onlineResults.length > 0 && categoryFilter !== 'recent' && (
                <>
                  <div className="col-span-full pt-1 pb-0.5 text-[10px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider flex items-center gap-1">
                    <Globe className="w-3 h-3 text-[#C4718E] dark:text-[#E5A4BA]" />
                    <span>OpenStreetMap Search Results</span>
                  </div>
                  {onlineResults.map((spot) => {
                    const isSelected =
                      selectedSpot?.id === spot.id ||
                      (selectedSpot?.coordinates[0] === spot.coordinates[0] &&
                        selectedSpot?.coordinates[1] === spot.coordinates[1]);
                    const savedMatch = findMatchingSavedLocation(spot);

                    return (
                      <div
                        key={spot.id}
                        className={`flex items-start gap-2 p-2.5 rounded-xl border text-left transition-all ${
                          isSelected
                            ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] border-[#171613] dark:border-[#F5EFE3] shadow-xs'
                            : 'glass-subtle text-[#171613] dark:text-[#F5EFE3]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectSpotItem(spot, true)}
                          className="flex items-start gap-2 flex-1 min-w-0 text-left cursor-pointer"
                        >
                          <MapPin
                            className={`w-4 h-4 shrink-0 mt-0.5 ${
                              isSelected ? 'text-[#D98BA5]' : 'text-[#82796F]'
                            }`}
                          />
                          <div className="min-w-0 flex-1">
                            <span className="text-xs font-semibold truncate block">{spot.name}</span>
                            <p
                              className={`text-[11px] truncate mt-0.5 ${
                                isSelected
                                  ? 'text-[#F5EFE3]/70 dark:text-[#171613]/70'
                                  : 'text-[#82796F] dark:text-[#A89F95]'
                              }`}
                            >
                              {spot.description}
                            </p>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (savedMatch) {
                              void removeSavedLocation(savedMatch.id);
                            } else {
                              void saveLocation({
                                name: spot.name,
                                category: spot.category,
                                description: spot.description,
                                address: spot.address,
                                coordinates: spot.coordinates,
                                isOffCampus: spot.isOffCampus,
                                source: 'search',
                              });
                            }
                          }}
                          title={savedMatch ? 'Saved' : 'Save searched location'}
                          className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 shrink-0 cursor-pointer"
                        >
                          <Bookmark
                            className={`w-3.5 h-3.5 ${savedMatch ? 'fill-current text-[#D98BA5]' : ''}`}
                          />
                        </button>
                      </div>
                    );
                  })}
                </>
              )}

              {/* Campus & Off-Campus Landmark Presets */}
              {filteredLocalSpots.length > 0 && (
                <>
                  {(categoryFilter === 'all' || onlineResults.length > 0) && (
                    <div className="col-span-full pt-1 pb-0.5 text-[10px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider flex items-center gap-1">
                      <MapPin className="w-3 h-3 text-[#C4718E] dark:text-[#E5A4BA]" />
                      <span>Campus &amp; Off-Campus Landmarks</span>
                    </div>
                  )}
                  {filteredLocalSpots.map((spot) => {
                    const isSelected =
                      selectedSpot?.id === spot.id ||
                      selectedSpot?.coordinates[0] === spot.coordinates[0];
                    const savedMatch = findMatchingSavedLocation(spot);

                    return (
                      <div
                        key={spot.id}
                        className={`flex items-start gap-2 p-2.5 rounded-xl border text-left transition-all ${
                          isSelected
                            ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] border-[#171613] dark:border-[#F5EFE3] shadow-xs'
                            : 'glass-subtle text-[#171613] dark:text-[#F5EFE3] hover:bg-[#FFFCF7]/80 dark:hover:bg-white/10'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectSpotItem(spot, Boolean(search.trim()))}
                          className="flex items-start gap-2 flex-1 min-w-0 text-left cursor-pointer"
                        >
                          <MapPin
                            className={`w-4 h-4 shrink-0 mt-0.5 ${
                              isSelected
                                ? 'text-[#D98BA5] dark:text-[#C4718E]'
                                : 'text-[#82796F] dark:text-[#A89F95]'
                            }`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-1">
                              <span className="text-xs font-semibold truncate">{spot.name}</span>
                              {isSelected && (
                                <Check className="w-3.5 h-3.5 text-[#D98BA5] dark:text-[#C4718E] shrink-0" />
                              )}
                            </div>
                            <p
                              className={`text-[11px] truncate mt-0.5 ${
                                isSelected
                                  ? 'text-[#F5EFE3]/70 dark:text-[#171613]/70'
                                  : 'text-[#82796F] dark:text-[#A89F95]'
                              }`}
                            >
                              {spot.description}
                            </p>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            if (savedMatch) {
                              void removeSavedLocation(savedMatch.id);
                            } else {
                              void saveLocation({
                                landmarkId: spot.id,
                                name: spot.name,
                                category: spot.category,
                                description: spot.description,
                                coordinates: spot.coordinates,
                                isOffCampus: spot.isOffCampus,
                                source: search.trim() ? 'search' : 'landmark',
                              });
                            }
                          }}
                          title={savedMatch ? 'Remove saved spot' : 'Save spot'}
                          className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 shrink-0 cursor-pointer"
                        >
                          <Bookmark
                            className={`w-3.5 h-3.5 ${
                              savedMatch ? 'fill-current text-[#D98BA5]' : ''
                            }`}
                          />
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-[#171613]/10 dark:border-white/10 bg-[#E8DDCC]/40 dark:bg-white/5 flex flex-wrap items-center justify-between gap-2 shrink-0">
          {currentLocation ? (
            <button
              type="button"
              onClick={handleRemove}
              className="inline-flex items-center gap-1.5 text-xs text-[#C4718E] dark:text-[#E5A4BA] hover:text-[#171613] dark:hover:text-[#F5EFE3] font-semibold cursor-pointer min-h-[36px]"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Remove Location</span>
            </button>
          ) : (
            <div className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
              {savedAsLocations.length} saved · Attaching automatically pins spot
            </div>
          )}

          <div className="flex items-center gap-2 ml-auto">
            <GlassButton variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </GlassButton>
            <GlassButton variant="pink" size="sm" onClick={handleConfirm} disabled={!selectedSpot}>
              Attach &amp; Pin
            </GlassButton>
          </div>
        </div>
      </div>
    </GlassModal>
  );
};
