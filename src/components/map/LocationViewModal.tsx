import React, { useEffect, useState } from 'react';
import {
  Bookmark,
  Car,
  Check,
  ChevronDown,
  Compass,
  Copy,
  ExternalLink,
  Footprints,
  LocateFixed,
  Navigation,
  Pin,
  Share2,
} from 'lucide-react';
import { CampusLocation, RouteInfo } from '../../types';
import {
  calculateRoute,
  DEFAULT_STUDENT_ORIGIN,
  formatDistance,
  formatDuration,
  getAppleMapsUrl,
  getGoogleMapsUrl,
  getOpenStreetMapUrl,
  POPULAR_START_POINTS,
} from '../../utils/navigation';
import { LazyLeafletMap } from './LazyLeafletMap';
import { GlassButton, GlassModal } from '../glass';
import { triggerHaptic } from '../../utils/haptics';
import { useSavedLocations } from '../../utils/useSavedLocations';

interface LocationViewModalProps {
  location: CampusLocation | null;
  onClose: () => void;
  initialShowDirections?: boolean;
}

export const LocationViewModal: React.FC<LocationViewModalProps> = ({
  location,
  onClose,
  initialShowDirections = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [showDirections, setShowDirections] = useState(initialShowDirections);
  const [travelMode, setTravelMode] = useState<'foot' | 'driving'>('foot');
  const [startPoint, setStartPoint] = useState<CampusLocation>(DEFAULT_STUDENT_ORIGIN);
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);
  const [isLocatingGPS, setIsLocatingGPS] = useState(false);
  const [showStartPointDropdown, setShowStartPointDropdown] = useState(false);
  const {
    findMatchingSavedLocation,
    saveLocation,
    pinLocation,
    togglePinLocation,
    removeSavedLocation,
  } = useSavedLocations();

  useEffect(() => {
    if (initialShowDirections) {
      setShowDirections(true);
    }
  }, [initialShowDirections]);

  useEffect(() => {
    if (!location || !showDirections) {
      setRouteInfo(null);
      return;
    }

    let isMounted = true;
    calculateRoute(startPoint.coordinates, location.coordinates, travelMode)
      .then((route) => {
        if (isMounted) setRouteInfo(route);
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [location, startPoint, travelMode, showDirections]);

  if (!location) return null;

  const handleCopy = () => {
    triggerHaptic('success');
    const text = `${location.name}: ${location.coordinates[0].toFixed(5)}, ${location.coordinates[1].toFixed(5)}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleUseGPS = () => {
    if (!navigator.geolocation) return;
    triggerHaptic('tap');

    setIsLocatingGPS(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setIsLocatingGPS(false);
        setStartPoint({
          id: 'user-gps',
          name: 'My Current GPS Location',
          category: 'custom',
          coordinates: [pos.coords.latitude, pos.coords.longitude],
          description: `Device GPS accuracy within ${Math.round(pos.coords.accuracy)}m`,
        });
        setShowStartPointDropdown(false);
      },
      () => {
        setIsLocatingGPS(false);
      },
      { timeout: 5000, enableHighAccuracy: true }
    );
  };

  const googleMapsUrl = getGoogleMapsUrl(
    location.coordinates,
    startPoint.coordinates,
    travelMode === 'foot' ? 'walking' : 'driving'
  );
  const appleMapsUrl = getAppleMapsUrl(
    location.coordinates,
    startPoint.coordinates,
    travelMode === 'foot' ? 'w' : 'd'
  );
  const osmUrl = getOpenStreetMapUrl(location.coordinates, startPoint.coordinates);

  return (
    <GlassModal
      isOpen={Boolean(location)}
      onClose={onClose}
      title={location.name}
      subtitle={`${location.isOffCampus ? 'Off-Campus Location' : 'Campus Spot'} · ${location.category}`}
      maxWidthClass="max-w-xl"
    >
      <div className="flex flex-col">
        <div className="p-3.5 bg-[#E8DDCC]/40 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10">
          <LazyLeafletMap
            center={location.coordinates}
            zoom={showDirections ? 15 : 17}
            selectedCoordinates={showDirections ? null : location.coordinates}
            selectedLabel={location.name}
            route={showDirections ? routeInfo : null}
            routeOrigin={showDirections ? startPoint : null}
            routeDestination={showDirections ? location : null}
            height={showDirections ? '240px' : '260px'}
          />
        </div>

        <div className="p-4 sm:p-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <GlassButton
              variant={showDirections ? 'glass' : 'pink'}
              size="md"
              onClick={() => setShowDirections(!showDirections)}
              className="flex-1 min-w-[165px]"
            >
              <Navigation className="w-4 h-4" />
              <span>{showDirections ? 'Close Navigation Route' : 'Get Directions'}</span>
            </GlassButton>

            {(() => {
              const savedMatch = findMatchingSavedLocation(location);
              return (
                <>
                  <GlassButton
                    variant={savedMatch ? 'black' : 'glass'}
                    size="md"
                    onClick={() => {
                      triggerHaptic('tap');
                      if (savedMatch) {
                        void removeSavedLocation(savedMatch.id);
                      } else {
                        void saveLocation({
                          id: location.id,
                          name: location.name,
                          category: location.category,
                          description: location.description,
                          address: location.address,
                          coordinates: location.coordinates,
                          isOffCampus: location.isOffCampus,
                          isPinned: false,
                          source: 'map',
                        });
                      }
                    }}
                    title={savedMatch ? 'Remove from Saved Locations' : 'Save location'}
                  >
                    <Bookmark className={`w-3.5 h-3.5 ${savedMatch ? 'fill-current text-[#D98BA5]' : ''}`} />
                    <span>{savedMatch ? 'Saved' : 'Save Spot'}</span>
                  </GlassButton>

                  <GlassButton
                    variant={savedMatch?.isPinned ? 'pink' : 'glass'}
                    size="md"
                    onClick={() => {
                      triggerHaptic('success');
                      if (savedMatch) {
                        void togglePinLocation(savedMatch.id);
                      } else {
                        void pinLocation(location, 'map');
                      }
                    }}
                    title={savedMatch?.isPinned ? 'Unpin location' : 'Pin & save location'}
                  >
                    <Pin className={`w-3.5 h-3.5 ${savedMatch?.isPinned ? 'fill-current' : ''}`} />
                    <span>{savedMatch?.isPinned ? 'Pinned' : 'Pin'}</span>
                  </GlassButton>
                </>
              );
            })()}

            <GlassButton variant="glass" size="md" onClick={handleCopy} title="Copy coordinates">
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-[#82796F] dark:text-[#A89F95]" />
                  <span>Copy</span>
                </>
              )}
            </GlassButton>
          </div>

          {showDirections ? (
            <div className="flex flex-col gap-3.5 glass-subtle rounded-2xl p-4 animate-sb-in">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-1 glass-cream p-1 rounded-xl">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setTravelMode('foot');
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
                      travelMode === 'foot'
                        ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613]'
                        : 'text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                    }`}
                  >
                    <Footprints className="w-3.5 h-3.5" />
                    <span>Walking</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setTravelMode('driving');
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
                      travelMode === 'driving'
                        ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613]'
                        : 'text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                    }`}
                  >
                    <Car className="w-3.5 h-3.5" />
                    <span>Drive / Shuttle</span>
                  </button>
                </div>

                {routeInfo && (
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#171613] dark:text-[#F5EFE3]">
                    <span className="text-sm font-bold text-[#171613] dark:text-[#F5EFE3] font-serif">
                      {formatDuration(routeInfo.durationSeconds)}
                    </span>
                    <span className="text-[#82796F] dark:text-[#A89F95]">·</span>
                    <span className="font-mono text-[#82796F] dark:text-[#A89F95] tabular-nums">
                      {formatDistance(routeInfo.distanceMeters)}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5 relative">
                <div className="flex items-center justify-between text-[11px] text-[#82796F] dark:text-[#A89F95]">
                  <span className="font-medium">Origin:</span>
                  <button
                    type="button"
                    onClick={handleUseGPS}
                    disabled={isLocatingGPS}
                    className="text-[#171613] dark:text-[#F5EFE3] hover:text-[#C4718E] dark:hover:text-[#E5A4BA] flex items-center gap-1 font-semibold cursor-pointer"
                  >
                    <LocateFixed className="w-3 h-3 text-[#C4718E] dark:text-[#E5A4BA]" />
                    <span>{isLocatingGPS ? 'Detecting GPS...' : 'Use My GPS'}</span>
                  </button>
                </div>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setShowStartPointDropdown(!showStartPointDropdown);
                    }}
                    className="w-full glass-input rounded-xl p-2.5 text-xs text-left text-[#171613] dark:text-[#F5EFE3] flex items-center justify-between cursor-pointer"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span className="w-2 h-2 rounded-full bg-[#D98BA5] shrink-0" />
                      <span className="font-medium truncate">{startPoint.name}</span>
                    </div>
                    <ChevronDown className="w-3.5 h-3.5 text-[#82796F] dark:text-[#A89F95] shrink-0" />
                  </button>

                  {showStartPointDropdown && (
                    <div className="absolute top-full left-0 right-0 mt-1.5 glass-strong rounded-xl shadow-xl z-20 py-1 divide-y divide-[#171613]/8 dark:divide-white/8">
                      {POPULAR_START_POINTS.map((sp) => (
                        <button
                          type="button"
                          key={sp.id}
                          onClick={() => {
                            triggerHaptic('tap');
                            setStartPoint(sp);
                            setShowStartPointDropdown(false);
                          }}
                          className="w-full px-3.5 py-2 text-left text-xs hover:bg-[#F6E2E6]/70 dark:hover:bg-[#D98BA5]/20 flex items-center justify-between cursor-pointer"
                        >
                          <span className="font-medium text-[#171613] dark:text-[#F5EFE3]">
                            {sp.name}
                          </span>
                          <span className="text-[10px] text-[#82796F] dark:text-[#A89F95] font-mono">
                            {sp.isOffCampus ? 'Off-Campus' : 'Campus'}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-2 border-t border-[#171613]/10 dark:border-white/10 flex flex-col gap-1.5">
                <div className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95]">
                  Open in External Navigation App:
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={googleMapsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl glass-cream text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]/70 dark:hover:bg-[#D98BA5]/20 text-xs font-medium transition-colors"
                  >
                    <Navigation className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
                    <span>Google Maps</span>
                    <ExternalLink className="w-3 h-3 text-[#82796F] dark:text-[#A89F95]" />
                  </a>

                  <a
                    href={appleMapsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl glass-cream text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]/70 dark:hover:bg-[#D98BA5]/20 text-xs font-medium transition-colors"
                  >
                    <Compass className="w-3.5 h-3.5 text-[#171613] dark:text-[#F5EFE3]" />
                    <span>Apple Maps</span>
                    <ExternalLink className="w-3 h-3 text-[#82796F] dark:text-[#A89F95]" />
                  </a>

                  <a
                    href={osmUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl glass-cream text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]/70 dark:hover:bg-[#D98BA5]/20 text-xs font-medium transition-colors"
                  >
                    <Share2 className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
                    <span>OpenStreetMap</span>
                    <ExternalLink className="w-3 h-3 text-[#82796F] dark:text-[#A89F95]" />
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {location.description && (
                <p className="text-xs sm:text-sm text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                  {location.description}
                </p>
              )}

              <div className="flex items-center justify-between text-xs text-[#82796F] dark:text-[#A89F95] pt-2 border-t border-[#171613]/10 dark:border-white/10 flex-wrap gap-2">
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-[#171613] dark:text-[#F5EFE3]">
                  <span className="text-[#82796F] dark:text-[#A89F95]">Coordinates:</span>
                  <span>
                    {location.coordinates[0].toFixed(5)}° N, {location.coordinates[1].toFixed(5)}° E
                  </span>
                </div>

                <a
                  href={googleMapsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#C4718E] dark:text-[#E5A4BA] hover:text-[#171613] dark:hover:text-[#F5EFE3] underline underline-offset-2"
                >
                  <span>View in Google Maps</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </GlassModal>
  );
};
