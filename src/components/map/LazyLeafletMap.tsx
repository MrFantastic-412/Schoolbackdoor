import React, { Suspense, lazy } from 'react';
import type { CampusLocation, RouteInfo } from '../../types';

export interface MapMarker {
  id: string;
  name: string;
  coordinates: [number, number];
  category?: string;
  description?: string;
}

export interface LazyLeafletMapProps {
  center: [number, number];
  zoom?: number;
  markers?: MapMarker[];
  selectedCoordinates?: [number, number] | null;
  selectedLabel?: string;
  onSelectCoordinates?: (coords: [number, number]) => void;
  route?: RouteInfo | null;
  routeOrigin?: CampusLocation | null;
  routeDestination?: CampusLocation | null;
  height?: string;
  className?: string;
}

const LeafletMapChunk = lazy(() =>
  import('./LeafletMap').then((m) => ({ default: m.LeafletMap }))
);

/**
 * Code-split wrapper around LeafletMap so Leaflet JS (~150KB) only loads
 * when a map modal or campus explorer map actually mounts.
 */
export const LazyLeafletMap: React.FC<LazyLeafletMapProps> = (props) => {
  const height = props.height || '320px';
  return (
    <Suspense
      fallback={
        <div
          style={{ height }}
          className={`w-full rounded-2xl bg-[#FFFCF7]/75 border border-[#171613]/10 flex items-center justify-center text-xs text-[#82796F] animate-pulse ${props.className || ''}`}
        >
          Loading campus map...
        </div>
      }
    >
      <LeafletMapChunk {...props} />
    </Suspense>
  );
};
