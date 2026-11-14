import { Types } from 'mongoose';

export interface PlatformEvent<D = Record<string, unknown>> {
  organisationId: Types.ObjectId;
  /** `<module>.<thing>.<happened>`, e.g. water.payment.posted. */
  name: string;
  data: D;
  at: Date;
}

export type EventHandler = (event: PlatformEvent) => Promise<unknown> | unknown;

/**
 * How modules hear about each other without importing each other. Events are emitted after the change
 * is committed; a failing listener is logged and never undoes or blocks the change that raised it.
 */
export class EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();

  /** Listens for one event name, every event of a module (`water.*`) or everything (`*`). */
  on(name: string, handler: EventHandler) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((h) => h !== handler));
  }

  async emit(organisationId: Types.ObjectId, name: string, data: Record<string, unknown> = {}) {
    const event: PlatformEvent = { organisationId, name, data, at: new Date() };
    const listeners = [...(this.handlers.get(name) ?? []), ...(this.handlers.get(`${name.split('.')[0]}.*`) ?? []), ...(this.handlers.get('*') ?? [])];
    for (const handler of listeners) {
      try {
        await handler(event);
      } catch (err) {
        console.error(`Listener for ${name} failed`, err);
      }
    }
  }
}
