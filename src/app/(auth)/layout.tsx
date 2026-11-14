import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sign in',
  // The sign-in page of a private system has nothing for search engines.
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
