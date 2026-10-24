// Every notification goes through here: it is journaled, sent quietly during quiet hours, and an
// urgent one repeats until someone presses «Принял» (in Telegram or in the panel). Pending repeats
// survive a restart: they live in the journal.
import type { Clock } from '../engine/clock.ts';
import { hhmm } from '../engine/time.ts';
import type { Delivery, NotificationRow, Store } from '../store/db.ts';
import { inQuiet, type NotifySettings } from './settings.ts';

export interface NotifyMeta { source?: string; urgent?: boolean }

// Telegram, as far as notifications are concerned.
export interface Messenger {
  send(text: string, o: { silent: boolean; ackId?: number }): Promise<{ deliveries: Delivery[]; errors: string[] }>;
  edit(deliveries: Delivery[], text: string): Promise<void>; // also removes the «Принял» button
}

export interface NotificationsOptions {
  store: Store;
  clock: Clock;
  timezone: string;
  settings: () => NotifySettings;
  messenger: () => Messenger | null;
  log?: (msg: string) => void;
  onChange?: () => void;
}

const URGENT = '🚨 ';
const times = (n: number) => {
  const d = n % 10, dd = n % 100;
  return `${n} ${d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'раза' : 'раз'}`;
};

export class Notifications {
  private readonly o: NotificationsOptions;
  private readonly timers = new Map<number, unknown>();

  constructor(o: NotificationsOptions) { this.o = o; }

  async send(text: string, meta: NotifyMeta = {}): Promise<number> {
    const now = this.o.clock.now();
    const urgent = meta.urgent === true;
    const quiet = !urgent && inQuiet(this.o.settings(), hhmm(now, this.o.timezone));
    const m = this.o.messenger();
    const id = this.o.store.addNotification({
      ts: now, source: meta.source ?? 'Домовой', text, urgent, quiet, status: m ? 'sent' : 'no_telegram', deliveries: [],
    });
    if (m) {
      const r = await m.send(urgent ? `${URGENT}${text}` : text, { silent: quiet, ackId: urgent ? id : undefined });
      this.o.store.updateNotification(id, {
        deliveries: r.deliveries,
        ...(r.deliveries.length ? {} : { status: 'failed' as const }),
        ...(r.errors.length ? { error: r.errors.join('; ') } : {}),
      });
    }
    const { everyMin, max } = this.o.settings().repeat;
    if (urgent && m && max > 0) this.schedule(id, now + everyMin * 60_000);
    this.o.log?.(`Уведомление${urgent ? ' (срочное)' : ''}${quiet ? ' (тихо)' : ''}: ${text}`);
    this.o.onChange?.();
    return id;
  }

  // false when there is nothing to accept (unknown id, not urgent, already accepted).
  async ack(id: number, who: string): Promise<boolean> {
    const n = this.o.store.notification(id);
    if (!n || !n.urgent || n.ackedAt !== null) return false;
    const now = this.o.clock.now();
    this.o.store.updateNotification(id, { ackedAt: now, ackedBy: who, nextAt: null });
    this.cancel(id);
    const m = this.o.messenger();
    if (m && n.deliveries.length) {
      await m.edit(n.deliveries, `${URGENT}${n.text}\n\n✓ Принял: ${who}, ${hhmm(now, this.o.timezone)}`).catch((e) => this.o.log?.(`Не обновил сообщение: ${(e as Error).message}`));
    }
    this.o.log?.(`Принято (${who}): ${n.text}`);
    this.o.onChange?.();
    return true;
  }

  // After a restart: repeats that were still due.
  resume(): void {
    for (const n of this.o.store.notifications({ filter: 'pending', limit: 200 })) {
      if (n.nextAt !== null) this.schedule(n.id, n.nextAt);
    }
  }

  pending(): NotificationRow[] { return this.o.store.notifications({ filter: 'pending', limit: 50 }); }

  stop(): void {
    for (const t of this.timers.values()) this.o.clock.clearTimeout(t);
    this.timers.clear();
  }

  private schedule(id: number, at: number): void {
    this.cancel(id);
    this.o.store.updateNotification(id, { nextAt: at });
    this.timers.set(id, this.o.clock.setTimeout(() => { this.timers.delete(id); void this.repeat(id); }, Math.max(0, at - this.o.clock.now())));
  }

  private cancel(id: number): void {
    const t = this.timers.get(id);
    if (t !== undefined) this.o.clock.clearTimeout(t);
    this.timers.delete(id);
  }

  private async repeat(id: number): Promise<void> {
    const n = this.o.store.notification(id);
    const m = this.o.messenger();
    if (!n || n.ackedAt !== null || !m) return;
    const { everyMin, max } = this.o.settings().repeat;
    const count = n.repeats + 1;
    const last = count >= max;
    const text = last
      ? `${URGENT}Никто не нажал «Принял», повторил ${times(count)}: ${n.text}`
      : `${URGENT}Повтор ${count} из ${max}: ${n.text}`;
    const r = await m.send(text, { silent: false, ackId: id });
    this.o.store.updateNotification(id, { repeats: count, deliveries: [...n.deliveries, ...r.deliveries], nextAt: null });
    if (!last) this.schedule(id, this.o.clock.now() + everyMin * 60_000);
    this.o.onChange?.();
  }
}
