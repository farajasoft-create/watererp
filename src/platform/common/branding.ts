import type { Connection, Types } from 'mongoose';
import { NotFoundException } from './errors';

export interface PortalBranding {
  portal: string;
  enabled: boolean;
  title: string;
  welcome: string;
  accent: string;
  logoUrl: string;
  contactEmail: string;
  contactPhone: string;
  footer: string;
}

const DEFAULTS: Omit<PortalBranding, 'portal'> = { enabled: true, title: '', welcome: '', accent: '#1d4ed8', logoUrl: '', contactEmail: '', contactPhone: '', footer: '' };

/**
 * A public portal's branding and whether it is open, as set under Portals → Portal settings. Any
 * module's public endpoint can call this; without the portals module (or settings) the defaults apply.
 */
export async function portalBranding(connection: Connection, organisationId: Types.ObjectId, portal: string): Promise<PortalBranding> {
  const doc = await connection.collection('portals_settings').findOne({ organisationId, portal });
  const set = (doc ?? {}) as Partial<PortalBranding>;
  return { portal, ...DEFAULTS, ...Object.fromEntries(Object.entries(set).filter(([k, v]) => k in DEFAULTS && v !== null && v !== undefined)) } as PortalBranding;
}

/** The branding of an open portal; a closed one answers as if it did not exist. */
export async function openPortal(connection: Connection, organisationId: Types.ObjectId, portal: string) {
  const b = await portalBranding(connection, organisationId, portal);
  if (!b.enabled) throw new NotFoundException('This portal is closed');
  return b;
}
