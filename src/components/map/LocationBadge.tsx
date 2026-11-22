import React from 'react';
import { MapPin, Navigation } from 'lucide-react';
import { CampusLocation } from '../../types';
import { triggerHaptic } from '../../utils/haptics';

interface LocationBadgeProps {
  location: CampusLocation;
  onClick?: (e: React.MouseEvent) => void;
  onDirectionsClick?: (e: React.MouseEvent) => void;
  className?: string;
  showCoordinates?: boolean;
}

export const LocationBadge: React.FC<LocationBadgeProps> = ({
  location,
  onClick,
  onDirectionsClick,
  className = '',
  showCoordinates = false,
}) => {
  return (
    <div className={`inline-flex flex-wrap items-center gap-1.5 max-w-full ${className}`}>
      <button
        type="button"
        onClick={(e) => {
          triggerHaptic('tap');
          onClick?.(e);
        }}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded-xl text-xs font-medium glass-subtle hover:bg-[#F6E2E6]/75 dark:hover:bg-[#D98BA5]/20 text-[#171613] dark:text-[#F5EFE3] transition-colors cursor-pointer group max-w-full"
        title="Click to view pinned location details and map"
      >
        <MapPin className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA] group-hover:text-[#171613] dark:group-hover:text-[#F5EFE3] transition-colors shrink-0" />
        <span className="truncate max-w-[170px] sm:max-w-[220px] font-sans">
          {location.name}
        </span>
        {location.isOffCampus && (
          <span className="text-[9px] font-mono uppercase bg-[#E8DDCC] dark:bg-[#2A2722] text-[#171613] dark:text-[#F5EFE3] px-1.5 py-0.5 rounded-md shrink-0">
            Off-Campus
          </span>
        )}
        {showCoordinates && (
          <span className="text-[10px] text-[#82796F] dark:text-[#A89F95] font-mono hidden md:inline shrink-0">
            ({location.coordinates[0].toFixed(3)}, {location.coordinates[1].toFixed(3)})
          </span>
        )}
      </button>

      {onDirectionsClick && (
        <button
          type="button"
          onClick={(e) => {
            triggerHaptic('tap');
            onDirectionsClick(e);
          }}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[34px] rounded-xl text-[11px] font-semibold bg-[#171613] dark:bg-[#2A2722] hover:bg-[#D98BA5] dark:hover:bg-[#D98BA5] text-[#F5EFE3] hover:text-[#171613] dark:hover:text-[#171613] transition-colors cursor-pointer shadow-2xs whitespace-nowrap shrink-0"
          title="Get walking / driving directions"
        >
          <Navigation className="w-3 h-3 shrink-0" />
          <span className="hidden sm:inline">Directions</span>
        </button>
      )}
    </div>
  );
};
