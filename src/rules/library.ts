// Rule and scene files: list them for the editor, check a draft (schema + references), save atomically,
// move deletions to .trash, and reload the engine when files change — from the panel or an editor.
// A broken file never stops a rule: the last good version keeps running and the error is reported.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import YAML from 'yaml';
import type { Device } from '../cube/normalize.ts';
import type { VarInfo } from '../engine/vars.ts';
import { conditionsOf, parseRule, parseScene, type Action, type Condition, type Rule, type Scene } from './schema.ts';

export type CardKind = 'rule' | 'scene';
export interface CardFile { kind: CardKind; file: string; id: string | null; name: string | null; yaml: string; raw: unknown; error?: string }
export interface Issue { path: string; message: string }
export interface CheckResult { ok: boolean; issues: Issue[]; warnings: string[]; yaml: string; raw: unknown; card?: Rule | Scene }
export interface CheckContext { devices: Device[]; vars: VarInfo[]; protected: string[] }

const SWITCH = /^(power|toggle\.\w+)$/;
const ORDER: Record<CardKind, string[]> = {
  rule: ['id', 'name', 'description', 'enabled', 'when', 'then', 'otherwise', 'cooldown'],
  scene: ['id', 'name', 'description', 'do'],
};
const norm = (s: string) => s.trim().toLowerCase();

// Keys in a readable order; YAML without line wrapping.
export function toYaml(kind: CardKind, raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return YAML.stringify(raw ?? {}, { lineWidth: 0 });
  const obj = raw as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const k of ORDER[kind]) if (obj[k] !== undefined) ordered[k] = obj[k];
  for (const [k, v] of Object.entries(obj)) if (!(k in ordered)) ordered[k] = v;
  return YAML.stringify(ordered, { lineWidth: 0 });
}

function issuesOf(err: unknown): Issue[] {
  const text = (err as Error).message;
  const lines = text.split('\n').slice(1);
  if (!lines.length) return [{ path: '', message: text }];
  return lines.map((l) => {
    const m = /^\s*([^:]*):\s(.*)$/.exec(l);
    return m ? { path: m[1] === '(корень)' ? '' : m[1]!, message: m[2]! } : { path: '', message: l.trim() };
  });
}

export interface LibraryOptions {
  rulesDir: string;
  scenesDir: string;
  context: () => CheckContext;
  onReload: (rules: Rule[], scenes: Scene[]) => Promise<void>;
  log?: (msg: string) => void;
}

export class Library {
  private readonly o: LibraryOptions;
  private readonly good = new Map<string, Rule | Scene>(); // "kind:file" → last version that parsed
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  errors: { kind: CardKind; file: string; error: string }[] = [];

  constructor(o: LibraryOptions) { this.o = o; }

  private dir(kind: CardKind): string { return kind === 'rule' ? this.o.rulesDir : this.o.scenesDir; }
  private parse(kind: CardKind, raw: unknown, origin: string): Rule | Scene {
    return kind === 'rule' ? parseRule(raw, origin) : parseScene(raw, origin);
  }

  files(kind?: CardKind): CardFile[] {
    const out: CardFile[] = [];
    for (const k of kind ? [kind] : (['rule', 'scene'] as CardKind[])) {
      const dir = this.dir(k);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
        const yaml = readFileSync(join(dir, file), 'utf8');
        let raw: unknown = null;
        let error: string | undefined;
        try {
          raw = YAML.parse(yaml);
          this.parse(k, raw, file);
        } catch (err) { error = (err as Error).message; }
        const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        out.push({ kind: k, file, id: typeof obj.id === 'string' ? obj.id : null, name: typeof obj.name === 'string' ? obj.name : null, yaml, raw, error });
      }
    }
    return out;
  }

  // Valid cards from disk; for a broken file the last good version stays (and the error is kept).
  load(): { rules: Rule[]; scenes: Scene[] } {
    this.errors = [];
    const result = { rules: [] as Rule[], scenes: [] as Scene[] };
    for (const f of this.files()) {
      const key = `${f.kind}:${f.file}`;
      let card: Rule | Scene | undefined;
      if (f.error) {
        this.errors.push({ kind: f.kind, file: f.file, error: f.error });
        card = this.good.get(key);
      } else {
        card = this.parse(f.kind, f.raw, f.file);
        this.good.set(key, card);
      }
      if (!card) continue;
      const list = (f.kind === 'rule' ? result.rules : result.scenes) as (Rule | Scene)[];
      if (list.some((c) => c.id === card!.id)) { this.errors.push({ kind: f.kind, file: f.file, error: `повторяется id «${card.id}» — файл пропущен` }); continue; }
      list.push(card);
    }
    return result;
  }

  async reload(): Promise<void> {
    const { rules, scenes } = this.load();
    for (const e of this.errors) this.o.log?.(`Карточка ${e.file} не загружена: ${e.error.split('\n')[0]}`);
    await this.o.onReload(rules, scenes);
  }

  // Schema check plus references to devices, variables and scenes. Accepts YAML text or a card object.
  check(kind: CardKind, input: { yaml?: string; card?: unknown }, originalId?: string): CheckResult {
    let raw: unknown = input.card;
    const issues: Issue[] = [];
    if (typeof input.yaml === 'string') {
      try { raw = YAML.parse(input.yaml); } catch (err) { return { ok: false, issues: [{ path: '', message: `YAML: ${(err as Error).message.split('\n')[0]}` }], warnings: [], yaml: input.yaml, raw: null }; }
    }
    const yaml = typeof input.yaml === 'string' ? input.yaml : toYaml(kind, raw);
    let card: Rule | Scene;
    try { card = this.parse(kind, raw, kind === 'rule' ? 'правило' : 'сцена'); } catch (err) { return { ok: false, issues: issuesOf(err), warnings: [], yaml, raw }; }

    const warnings: string[] = [];
    const ctx = this.o.context();
    const others = this.files(kind).filter((f) => f.id && f.id !== originalId);
    if (others.some((f) => f.id === card.id)) issues.push({ path: 'id', message: `id «${card.id}» уже занят — выбери другой` });
    const sceneIds = new Set(this.files('scene').map((f) => f.id).filter(Boolean) as string[]);
    if (kind === 'scene') sceneIds.add(card.id);

    const device = (ref: string) => ctx.devices.filter((d) => norm(d.name) === norm(ref) || norm(d.cubeName ?? d.name) === norm(ref) || norm(d.id) === norm(ref));
    const checkCondition = (c: Condition, path: string) => {
      if ('device' in c) {
        const found = device(c.device);
        if (!found.length) warnings.push(`${path}: устройства «${c.device}» сейчас нет в CUBE`);
        else if (found.length > 1) issues.push({ path, message: `в CUBE несколько устройств «${c.device}» — укажи id` });
        else if (!(c.attr in found[0]!.attrs)) warnings.push(`${path}: «${c.device}» не присылает «${c.attr}» (есть: ${Object.keys(found[0]!.attrs).join(', ')})`);
      } else if ('var' in c) {
        const v = ctx.vars.find((x) => x.name === c.var);
        if (!v) issues.push({ path, message: `нет переменной «${c.var}» (есть: ${ctx.vars.map((x) => x.name).join(', ') || '—'})` });
        else if (v.options && !v.options.some((o) => o.value === c.is)) issues.push({ path, message: `«${c.var}» не бывает «${c.is}» (можно: ${v.options.map((o) => o.value).join(', ')})` });
      }
    };
    const checkAction = (a: Action, path: string) => {
      a.if?.forEach((c, i) => checkCondition(c, `${path}.if.${i}`));
      if ('set' in a) {
        if (!SWITCH.test(a.set.attr)) issues.push({ path, message: `управлять можно только power и toggle.N, а не «${a.set.attr}»` });
        const found = device(a.set.device);
        if (!found.length) warnings.push(`${path}: устройства «${a.set.device}» сейчас нет в CUBE`);
        else if (ctx.protected.some((p) => norm(p) === norm(a.set.device) || norm(p) === norm(found[0]!.id))) warnings.push(`${path}: «${a.set.device}» защищено — действие не выполнится`);
        else if (!(a.set.attr in found[0]!.attrs)) warnings.push(`${path}: у «${a.set.device}» нет «${a.set.attr}»`);
      } else if ('set_var' in a) {
        const v = ctx.vars.find((x) => x.name === a.set_var.var);
        if (!v) issues.push({ path, message: `нет переменной «${a.set_var.var}»` });
        else if (v.readonly) issues.push({ path, message: `«${v.label}» считается само — менять нельзя` });
        else if (v.options && !v.options.some((o) => o.value === a.set_var.to)) issues.push({ path, message: `«${a.set_var.var}» не бывает «${a.set_var.to}»` });
      } else if ('scene' in a && !sceneIds.has(a.scene)) {
        issues.push({ path, message: `нет сцены «${a.scene}» (есть: ${[...sceneIds].join(', ') || '—'})` });
      }
    };
    if (kind === 'rule') {
      const r = card as Rule;
      conditionsOf(r).forEach((c, i) => checkCondition(c, `when.${'all' in r.when ? 'all' : 'any'}.${i}`));
      r.then.forEach((a, i) => checkAction(a, `then.${i}`));
      r.otherwise?.do.forEach((a, i) => checkAction(a, `otherwise.do.${i}`));
    } else {
      (card as Scene).do.forEach((a, i) => checkAction(a, `do.${i}`));
    }
    return { ok: issues.length === 0, issues, warnings, yaml, raw, card };
  }

  // Writes the card (its existing file, or <id>.yaml) atomically and reloads the engine.
  async save(kind: CardKind, input: { yaml?: string; card?: unknown }, originalId?: string): Promise<{ id: string; file: string; created: boolean }> {
    const checked = this.check(kind, input, originalId);
    if (!checked.ok) throw new Error(checked.issues.map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`).join('; '));
    const card = this.parse(kind, checked.raw, 'карточка');
    const dir = this.dir(kind);
    mkdirSync(dir, { recursive: true });
    const existing = this.files(kind).find((f) => f.id === (originalId ?? card.id));
    const file = existing && existing.id === card.id ? existing.file : `${card.id}.yaml`;
    if (!existing && existsSync(join(dir, file))) throw new Error(`файл ${file} уже есть`);
    const text = typeof input.yaml === 'string' ? input.yaml : toYaml(kind, checked.raw);
    writeFileSync(join(dir, `.${file}.tmp`), text.endsWith('\n') ? text : `${text}\n`);
    renameSync(join(dir, `.${file}.tmp`), join(dir, file));
    if (existing && existing.file !== file) this.trash(dir, existing.file); // the id changed
    await this.reload();
    return { id: card.id, file, created: !existing };
  }

  async remove(kind: CardKind, id: string): Promise<string> {
    const f = this.files(kind).find((x) => x.id === id);
    if (!f) throw new Error(`нет ${kind === 'rule' ? 'правила' : 'сцены'} «${id}»`);
    const where = this.trash(this.dir(kind), f.file);
    await this.reload();
    return where;
  }

  private trash(dir: string, file: string): string {
    const bin = join(dir, '.trash');
    mkdirSync(bin, { recursive: true });
    const target = join(bin, `${basename(file, '.yaml')}-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`);
    renameSync(join(dir, file), target);
    this.good.delete(`${dir === this.o.rulesDir ? 'rule' : 'scene'}:${file}`);
    return target;
  }

  // Changes made in a text editor are picked up too (debounced).
  watch(): void {
    for (const dir of [this.o.rulesDir, this.o.scenesDir]) {
      if (!existsSync(dir)) continue;
      try {
        this.watchers.push(watch(dir, (_e, name) => {
          if (!name || name.startsWith('.') || !/\.ya?ml$/.test(String(name))) return;
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => { this.timer = null; void this.reload(); }, 400);
        }));
      } catch (err) { this.o.log?.(`Не слежу за ${dir}: ${(err as Error).message}`); }
    }
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
  }
}
