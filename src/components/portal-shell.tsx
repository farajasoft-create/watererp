import type { ReactNode } from 'react';

export interface Branding { title?: string; welcome?: string; accent?: string; logoUrl?: string; contactEmail?: string; contactPhone?: string; footer?: string }

/**
 * The frame every public portal page shares: the organisation's own title, logo, colour and welcome
 * text for that portal (set under Portals → Portal settings), and its contacts and footer.
 */
export function PortalShell({ organisation, fallbackTitle, branding, children }: { organisation: string; fallbackTitle: string; branding?: Branding | null; children: ReactNode }) {
  const accent = branding?.accent && /^#[0-9a-fA-F]{6}$/.test(branding.accent) ? branding.accent : '#1d4ed8';
  return (
    <div className="min-h-screen bg-slate-50" style={{ ['--portal-accent' as string]: accent }}>
      <header className="text-white" style={{ background: accent }}>
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-4">
          {branding?.logoUrl && <img src={branding.logoUrl} alt="" className="h-10 w-10 rounded bg-white object-contain p-1" />}
          <div>
            <div className="text-xs uppercase tracking-wide opacity-80">{organisation}</div>
            <h1 className="text-xl font-semibold">{branding?.title || fallbackTitle}</h1>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        {branding?.welcome && <p className="text-sm text-slate-700">{branding.welcome}</p>}
        {children}
      </main>
      {(branding?.contactEmail || branding?.contactPhone || branding?.footer) && (
        <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-muted">
          {[branding.contactPhone, branding.contactEmail].filter(Boolean).join(' · ')}
          {branding.footer && <div className="mt-1">{branding.footer}</div>}
        </footer>
      )}
    </div>
  );
}
