import type { ReactNode } from 'react';
import { SvgIcon } from '@mui/material';

// Thin line icons for the side menu: the outline follows the menu's icon colour, a few strokes are accented.
const ACCENT = '#e040fb';

function NavSvg({ children }: { children: ReactNode }) {
  return (
    <SvgIcon viewBox="0 0 32 32" sx={{ fontSize: 32, color: 'inherit' }}>
      <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{children}</g>
    </SvgIcon>
  );
}

// Magenta by default; the side menu sets --nav-accent to the ink colour on the open page's icon.
const accent = { style: { stroke: `var(--nav-accent, ${ACCENT})` } } as const;

export function AccountNavIcon() {
  return (
    <NavSvg>
      <path d="M4 10.5A2.5 2.5 0 0 1 6.5 8H25a3 3 0 0 1 3 3v12.5A2.5 2.5 0 0 1 25.5 26h-19A2.5 2.5 0 0 1 4 23.5z" />
      <path d="M4 12.5h24" />
      <rect x="19" y="15.5" width="9" height="6" rx="3" />
      <circle cx="23" cy="18.5" r="0.9" {...accent} />
    </NavSvg>
  );
}

export function MosaicNavIcon() {
  return (
    <NavSvg>
      <ellipse cx="12" cy="9" rx="8" ry="3" />
      <path d="M4 9v13c0 1.7 3.6 3 8 3s8-1.3 8-3V9" />
      <path d="M4 15.5c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      <path d="M20 6.2c4-.9 8.5.2 8.5 2.2v13c0 1.2-1.6 2.2-4 2.7" {...accent} />
      <path d="M20 12.2c3.2-.4 6.2.3 8 1.5M20 18.2c3.2-.4 6.2.3 8 1.5" {...accent} />
    </NavSvg>
  );
}

export function NamespaceNavIcon() {
  return (
    <NavSvg>
      <path d="M4.5 4.5h11.8L28 16.2 16.2 28 4.5 16.3z" />
      <circle cx="10.5" cy="10.5" r="1.8" />
      <path d="M16 14l4.5 4.5" {...accent} />
    </NavSvg>
  );
}

export function MetadataNavIcon() {
  return (
    <NavSvg>
      <path d="M11 5.5c-2.6 0-3.5 1.2-3.5 3.2v3.1c0 1.7-.8 2.7-2.5 3.2 1.7.5 2.5 1.5 2.5 3.2v3.1c0 2 .9 3.2 3.5 3.2" />
      <path d="M21 5.5c2.6 0 3.5 1.2 3.5 3.2v3.1c0 1.7.8 2.7 2.5 3.2-1.7.5-2.5 1.5-2.5 3.2v3.1c0 2-.9 3.2-3.5 3.2" />
      <circle cx="12.5" cy="16" r="1" {...accent} />
      <circle cx="16" cy="16" r="1" {...accent} />
      <circle cx="19.5" cy="16" r="1" {...accent} />
    </NavSvg>
  );
}

export function MultisigNavIcon() {
  return (
    <NavSvg>
      <circle cx="16" cy="6.5" r="2.7" />
      <path d="M11 13a5 5 0 0 1 3-3.3M21 13a5 5 0 0 0-3-3.3" />
      <circle cx="6.5" cy="23.5" r="2.7" />
      <path d="M2 30a4.6 4.6 0 0 1 9 0" />
      <circle cx="25.5" cy="23.5" r="2.7" />
      <path d="M21 30a4.6 4.6 0 0 1 9 0" />
      <rect x="11.5" y="14" width="9" height="7" rx="1.2" {...accent} />
      <path d="M14 17.5h4" {...accent} />
    </NavSvg>
  );
}

export function HarvestNavIcon() {
  return (
    <NavSvg>
      <path d="M16 15V9" {...accent} />
      <path d="M16 11.5c-4.2 0-5.6-2.7-5.6-5.3 4.2 0 5.6 2.4 5.6 5.3z" {...accent} />
      <path d="M16 10c0-3 2-4.6 5.4-4.6 0 3-2 4.6-5.4 4.6z" {...accent} />
      <path d="M3 21h4.5v8H3z" />
      <path d="M7.5 22.5l6-1.8h6c2.2 0 2.6 3.1.2 3.2l-5.2.2" />
      <path d="M7.5 27l8.5 1.8 11-6c1.2-.8.4-2.6-1.2-2l-5.6 2.4" />
    </NavSvg>
  );
}

export function AggregateNavIcon() {
  return (
    <NavSvg>
      <circle cx="16" cy="10.5" r="7" />
      <circle cx="10" cy="21" r="7" />
      <circle cx="22" cy="21" r="7" />
      <path d="M13.5 21h5M17 19.2l1.8 1.8-1.8 1.8" {...accent} />
      <path d="M13 9.5h6M15.2 7.8l-1.8 1.7 1.8 1.7" {...accent} />
    </NavSvg>
  );
}
