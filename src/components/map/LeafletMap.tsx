import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { CampusLocation, RouteInfo } from '../../types';

interface MapMarker {
  id: string;
  name: string;
  coordinates: [number, number];
  category?: string;
  description?: string;
  pinVariant?: 'default' | 'saved' | 'pinned';
}

interface LeafletMapProps {
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

function buildPopupElement(options: {
  eyebrow?: { text: string; color: string };
  title: string;
  description?: string;
  coords?: [number, number];
}): HTMLElement {
  const container = document.createElement('div');
  container.style.padding = '4px 6px';

  if (options.eyebrow) {
    const eyebrowEl = document.createElement('div');
    eyebrowEl.style.fontSize = '10px';
    eyebrowEl.style.color = options.eyebrow.color;
    eyebrowEl.style.fontWeight = '700';
    eyebrowEl.style.textTransform = 'uppercase';
    eyebrowEl.textContent = options.eyebrow.text;
    container.appendChild(eyebrowEl);
  }

  const titleEl = document.createElement('div');
  titleEl.style.fontWeight = '700';
  titleEl.style.fontSize = '13px';
  titleEl.style.color = 'var(--sb-black)';
  titleEl.textContent = options.title;
  container.appendChild(titleEl);

  if (options.description) {
    const descEl = document.createElement('div');
    descEl.style.fontSize = '11px';
    descEl.style.color = 'var(--sb-muted)';
    descEl.style.marginTop = '2px';
    descEl.textContent = options.description;
    container.appendChild(descEl);
  }

  if (options.coords) {
    const coordsEl = document.createElement('div');
    coordsEl.style.fontSize = '10px';
    coordsEl.style.color = 'var(--sb-muted)';
    coordsEl.style.fontFamily = 'monospace';
    coordsEl.style.marginTop = '4px';
    coordsEl.textContent = `${options.coords[0].toFixed(4)}° N, ${options.coords[1].toFixed(4)}° E`;
    container.appendChild(coordsEl);
  }

  return container;
}

export const LeafletMap: React.FC<LeafletMapProps> = ({
  center,
  zoom = 16,
  markers = [],
  selectedCoordinates,
  selectedLabel,
  onSelectCoordinates,
  route,
  routeOrigin,
  routeDestination,
  height = '320px',
  className = '',
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const routeLayerGroupRef = useRef<L.LayerGroup | null>(null);

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const map = L.map(mapContainerRef.current, {
      center,
      zoom,
      zoomControl: false,
      scrollWheelZoom: true,
      attributionControl: true,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    const markerGroup = L.layerGroup().addTo(map);
    const routeGroup = L.layerGroup().addTo(map);
    markerLayerGroupRef.current = markerGroup;
    routeLayerGroupRef.current = routeGroup;
    mapInstanceRef.current = map;

    if (onSelectCoordinates) {
      map.on('click', (e: L.LeafletMouseEvent) => {
        onSelectCoordinates([e.latlng.lat, e.latlng.lng]);
      });
    }

    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 250);

    return () => {
      clearTimeout(timer);
      map.remove();
      mapInstanceRef.current = null;
      markerLayerGroupRef.current = null;
      routeLayerGroupRef.current = null;
    };
  }, []);

  // Update center when not in route mode
  useEffect(() => {
    if (mapInstanceRef.current && !route) {
      mapInstanceRef.current.setView(center, zoom, { animate: true });
    }
  }, [center[0], center[1], zoom, !!route]);

  // Handle route rendering and bounds fitting
  useEffect(() => {
    if (!mapInstanceRef.current || !routeLayerGroupRef.current) return;

    routeLayerGroupRef.current.clearLayers();

    if (route && route.coordinates && route.coordinates.length > 1) {
      const isWalking = route.profile === 'foot';

      // Background casing line for high contrast
      const casing = L.polyline(route.coordinates, {
        color: '#FFFFFF',
        weight: 6,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round',
      });
      routeLayerGroupRef.current.addLayer(casing);

      // Primary route line
      const polyline = L.polyline(route.coordinates, {
        color: '#171613',
        weight: isWalking ? 4 : 5,
        opacity: 0.95,
        dashArray: isWalking ? '6, 8' : undefined,
        lineCap: 'round',
        lineJoin: 'round',
      });
      routeLayerGroupRef.current.addLayer(polyline);

      // Origin Pin (Starting point)
      if (routeOrigin) {
        const originHtml = `
          <div style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9999px;background-color:#D98BA5;color:#171613;border:2.5px solid #FFFCF7;box-shadow:0 3px 6px rgba(23,22,19,0.28);">
            <div style="width:8px;height:8px;border-radius:9999px;background-color:#171613;"></div>
          </div>
        `;
        const originIcon = L.divIcon({
          className: 'custom-map-pin',
          html: originHtml,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          popupAnchor: [0, -14],
        });
        const originMarker = L.marker(routeOrigin.coordinates, { icon: originIcon });
        originMarker.bindPopup(
          buildPopupElement({
            eyebrow: { text: 'Starting Point', color: '#C4718E' },
            title: routeOrigin.name,
          })
        );
        routeLayerGroupRef.current.addLayer(originMarker);
      }

      // Destination Pin
      if (routeDestination) {
        const destHtml = `
          <div class="custom-pin-point" style="background-color:#171613;transform:scale(1.15);border-color:#FFFCF7;color:#F5EFE3;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
          </div>
        `;
        const destIcon = L.divIcon({
          className: 'custom-map-pin',
          html: destHtml,
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        });
        const destMarker = L.marker(routeDestination.coordinates, { icon: destIcon });
        destMarker.bindPopup(
          buildPopupElement({
            eyebrow: { text: 'Destination', color: '#82796F' },
            title: routeDestination.name,
          })
        );
        routeLayerGroupRef.current.addLayer(destMarker);
      }

      // Auto-fit bounds
      const bounds = L.latLngBounds(route.coordinates);
      mapInstanceRef.current.fitBounds(bounds, {
        padding: [45, 45],
        maxZoom: 17,
        animate: true,
      });
    }
  }, [route, routeOrigin, routeDestination]);

  // Update regular markers when not showing a route
  useEffect(() => {
    if (!mapInstanceRef.current || !markerLayerGroupRef.current) return;

    markerLayerGroupRef.current.clearLayers();

    // If route is actively displayed, markers are managed by route layer
    if (route) return;

    // Render registered landmarks and saved/pinned locations
    markers.forEach((m) => {
      const isSelected =
        selectedCoordinates &&
        Math.abs(selectedCoordinates[0] - m.coordinates[0]) < 0.0001 &&
        Math.abs(selectedCoordinates[1] - m.coordinates[1]) < 0.0001;

      const variantClass =
        m.pinVariant === 'pinned'
          ? 'pin-pinned'
          : m.pinVariant === 'saved'
          ? 'pin-saved'
          : '';

      const selectedStyle = isSelected
        ? 'background-color: #D98BA5; color: #171613; transform: scale(1.15); border-color: #171613;'
        : m.pinVariant
        ? ''
        : 'background-color: #171613; color: #F5EFE3; border-color: #FFFCF7;';

      const pinHtml = `
        <div class="custom-pin-point ${variantClass}" style="${selectedStyle}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
        </div>
      `;

      const customIcon = L.divIcon({
        className: 'custom-map-pin',
        html: pinHtml,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32],
      });

      const marker = L.marker(m.coordinates, { icon: customIcon });
      marker.bindPopup(
        buildPopupElement({
          eyebrow:
            m.pinVariant === 'pinned'
              ? { text: 'Pinned Location', color: '#C4718E' }
              : m.pinVariant === 'saved'
              ? { text: 'Saved Location', color: '#82796F' }
              : undefined,
          title: m.name,
          description: m.description,
          coords: m.coordinates,
        })
      );
      markerLayerGroupRef.current?.addLayer(marker);
    });

    // Render custom picked pin if it doesn't match any pre-existing landmark
    if (selectedCoordinates) {
      const isAlreadyCovered = markers.some(
        (m) =>
          Math.abs(m.coordinates[0] - selectedCoordinates[0]) < 0.0001 &&
          Math.abs(m.coordinates[1] - selectedCoordinates[1]) < 0.0001
      );

      if (!isAlreadyCovered) {
        const customPinHtml = `
          <div class="custom-pin-point" style="background-color: #D98BA5; color: #171613; border-color: #171613;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
          </div>
        `;

        const customIcon = L.divIcon({
          className: 'custom-map-pin',
          html: customPinHtml,
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        });

        const customMarker = L.marker(selectedCoordinates, { icon: customIcon });
        const label = selectedLabel || 'Selected Custom Point';
        customMarker
          .bindPopup(
            buildPopupElement({
              title: label,
              coords: selectedCoordinates,
            })
          )
          .openPopup();
        markerLayerGroupRef.current?.addLayer(customMarker);
      }
    }
  }, [markers, selectedCoordinates, selectedLabel, route]);

  return (
    <div
      ref={mapContainerRef}
      style={{ height, width: '100%' }}
      className={`relative rounded-2xl overflow-hidden border border-[#171613]/15 dark:border-white/15 shadow-inner z-0 ${className}`}
    />
  );
};
