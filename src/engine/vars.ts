// Variables: plain ones from config (e.g. ac_running), choice ones (mode: home / away / night / vacation),
// and presence — one "home_<id>" per person plus "anyone_home", which is computed and read-only.
import type { Value } from '../cube/normalize.ts';
import { VAR_REF, type Store } from '../store/db.ts';

export interface VarDef { label: string; initial: Value; options?: { value: string; label: string }[] }
export interface Person { name: string; telegram?: number }
export interface VarInfo { name: string; label: string; value: Value; options?: { value: string; label: string }[]; readonly?: boolean; person?: string }

export const ANYONE_HOME = 'anyone_home';
export const homeVar = (personId: string) => `home_${personId}`;

export class Variables {
  private readonly defs = new Map<string, VarDef & { person?: string; readonly?: boolean }>();
  private readonly values = new Map<string, Value>();
  private readonly store: Store;

  constructor(store: Store, vars: Record<string, VarDef> = {}, people: Record<string, Person> = {}) {
    this.store = store;
    for (const [name, def] of Object.entries(vars)) this.defs.set(name, def);
    for (const [id, p] of Object.entries(people)) this.defs.set(homeVar(id), { label: `${p.name} дома`, initial: true, person: id });
    if (Object.keys(people).length) this.defs.set(ANYONE_HOME, { label: 'Кто-нибудь дома', initial: true, readonly: true });
    const saved = store.vars();
    for (const [name, def] of this.defs) this.values.set(name, saved.has(name) ? saved.get(name)! : def.initial);
    if (Object.keys(people).length) this.values.set(ANYONE_HOME, this.anyoneHome());
  }

  has(name: string): boolean { return this.defs.has(name); }
  get(name: string): Value | undefined { return this.values.get(name); }
  label(name: string): string { return this.defs.get(name)?.label ?? name; }

  list(): VarInfo[] {
    return [...this.defs].map(([name, d]) => ({
      name, label: d.label, value: this.values.get(name) ?? null,
      ...(d.options ? { options: d.options } : {}), ...(d.readonly ? { readonly: true } : {}), ...(d.person ? { person: d.person } : {}),
    }));
  }

  // Sets a value after checking it; returns every variable that changed (presence also moves anyone_home).
  set(name: string, value: Value, ts: number): string[] {
    const def = this.defs.get(name);
    if (!def) throw new Error(`Нет переменной «${name}». Есть: ${[...this.defs.keys()].join(', ') || '—'}`);
    if (def.readonly) throw new Error(`«${def.label}» считается само — из того, кто дома`);
    if (def.options && !def.options.some((o) => o.value === value)) {
      throw new Error(`«${def.label}»: можно ${def.options.map((o) => `${o.value} (${o.label})`).join(', ')}`);
    }
    if (def.person && typeof value !== 'boolean') throw new Error(`«${def.label}»: только да или нет`);
    const changed: string[] = [];
    if (this.values.get(name) !== value) changed.push(name);
    this.values.set(name, value);
    this.store.saveVar(name, value, ts);
    if (def.person) {
      const anyone = this.anyoneHome();
      if (this.values.get(ANYONE_HOME) !== anyone) { this.values.set(ANYONE_HOME, anyone); changed.push(ANYONE_HOME); }
    }
    for (const n of changed) this.store.addChange(ts, VAR_REF, n, this.values.get(n) ?? null);
    return changed;
  }

  // Every value at once (engine start), so a replay knows where variable history begins.
  snapshot(ts: number): void {
    for (const [name, v] of this.values) this.store.addChange(ts, VAR_REF, name, v);
  }

  // Display text for a value: option labels for choice variables.
  text(name: string, value: Value): string | null {
    return this.defs.get(name)?.options?.find((o) => o.value === value)?.label ?? null;
  }

  private anyoneHome(): boolean {
    return [...this.defs].some(([name, d]) => d.person && this.values.get(name) === true);
  }
}
