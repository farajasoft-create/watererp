import { MANIFESTS } from '@/modules/manifests';
import { ModuleManifest, NavItem } from '@/platform/manifest';
import { Me } from './types';

export interface MenuSection {
  module: ModuleManifest;
  items: NavItem[];
  links: NavItem[];
}

const visible = (me: Me) => (n: NavItem) => !n.permission || me.permissions.includes(n.permission);

/** The modules this user can open, with the pages they may see in each. */
export function menuFor(me: Me | undefined): MenuSection[] {
  if (!me) return [];
  return MANIFESTS.filter((m) => me.modules.includes(m.key))
    .map((m) => ({ module: m, items: m.nav.filter(visible(me)), links: (m.links ?? []).filter(visible(me)) }))
    .filter((s) => s.items.length || s.links.length);
}

/** Where to go after signing in: straight into the only thing a user can do, otherwise the home page. */
export function landingPage(me: Me): string {
  const menu = menuFor(me);
  if (menu.length === 1) {
    const [only] = menu;
    if (!only.items.length && only.links.length) return only.links[0].href;
    if (!me.isAdmin) return only.items[0]?.href ?? '/';
  }
  return '/';
}
