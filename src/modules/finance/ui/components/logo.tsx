import { useId } from 'react';

/** The FarajaSoft mark: two folded planes forming an "S" (blue to teal, and blue to violet). */
export function Logo({ className = 'h-7 w-7', title }: { className?: string; title?: string }) {
  // Gradient ids must be unique when the mark appears more than once on a page.
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="40 420 1350 1200" className={className} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <linearGradient id={`${id}a`} x1="0" y1="600" x2="0" y2="1420" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7a74c8" />
          <stop offset="1" stopColor="#1aa3cc" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="520" y1="980" x2="1000" y2="760" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5b6cff" />
          <stop offset="0.55" stopColor="#a35fd0" />
        </linearGradient>
        <linearGradient id={`${id}c`} x1="560" y1="880" x2="700" y2="1100" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5b6cff" />
          <stop offset="1" stopColor="#a35fd0" />
        </linearGradient>
        <linearGradient id={`${id}d`} x1="420" y1="1560" x2="940" y2="1470" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a35fd0" />
          <stop offset="1" stopColor="#5b6cff" />
        </linearGradient>
      </defs>
      <polygon points="58,600 407,438 863,580 363,810" fill="#5271ff" />
      <polygon points="58,600 363,810 632,1420" fill={`url(#${id}a)`} />
      <polygon points="480,858 822,1048 940,1605" fill={`url(#${id}c)`} />
      <polygon points="480,858 920,618 1372,762 822,1048" fill={`url(#${id}b)`} />
      <polygon points="65,1517 833,1432 942,1605" fill={`url(#${id}d)`} />
    </svg>
  );
}
