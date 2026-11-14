import type { Metadata } from 'next';
import { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Your account',
  // The address contains the customer's private key.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function PortalLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-gray-50">{children}</div>;
}
