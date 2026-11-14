import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'FarajaSoft', template: '%s · FarajaSoft' },
  description: 'One system for the whole organisation: water billing, finance, HR and more, as modules',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = { themeColor: '#007bb6', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
