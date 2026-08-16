import type { SVGProps } from 'react';
import { cn } from '@/lib/utils';

interface IGrokIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
}

/** xAI's Grok mark: the slashed bar glyph, drawn on currentColor. */
const GrokIcon = ({ className, size, ...props }: IGrokIconProps) => (
  <svg
    {...props}
    height={size ?? '1em'}
    width={size ?? '1em'}
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('shrink-0', className)}
  >
    <path
      d="M9.27 15.29 17.4 9.2c.4-.3.98-.19 1.2.26.98 2 .6 4.5-1.1 6.2-1.7 1.7-4.2 2.1-6.3 1.15l-2.2 1.02c3.2 2.2 7.1 1.7 9.6-.8 1.98-1.98 2.6-4.72 1.9-7.18l.01.02c-1-3.6.03-5.04 2.17-8.02L24 1.5l-3.3 3.3V4.8L9.26 15.28ZM6.9 18.1C4.4 15.7 4.83 12 6.86 9.96c1.5-1.5 3.9-2.12 6.05-1.15L15.1 7.8a6.86 6.86 0 0 0-2.06-.98C9.9 5.9 6.6 6.77 4.4 8.98a8.55 8.55 0 0 0-2.2 8.35c.6 2.2.05 3.75-1.25 5.2-.32.36-.63.72-.95 1.05l6.9-5.48Z"
      fill="currentColor"
    />
  </svg>
);

export default GrokIcon;
