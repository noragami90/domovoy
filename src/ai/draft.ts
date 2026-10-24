// "Describe it in words": Claude drafts a rule or scene card, the library checks it, and Claude
// fixes what the check found (up to three tries). The draft is only opened in the editor —
// a person reads it and saves it; nothing here runs or changes the house.
import Anthropic from '@anthropic-ai/sdk';
import type { CardKind, CheckResult } from '../rules/library.ts';
import { houseText, OUTPUT_SCHEMA, SYSTEM_PROMPT, type HouseContext } from './prompt.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface DrafterOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  check: (kind: CardKind, yaml: string) => CheckResult;
  baseURL?: string; // tests point it at a fake server; otherwise the SDK default (or ANTHROPIC_BASE_URL)
  workspaceId?: string; // for a key that is not scoped to a workspace (ANTHROPIC_WORKSPACE_ID)
}

export interface DraftResult {
  kind: CardKind;
  yaml: string;
  card: unknown;            // parsed YAML for the editor form (null when there is no card)
  summary: string;
  assumptions: string[];
  question: string | null;  // Claude could not draft and says why
  check: CheckResult | null;
  attempts: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }; // input = uncached part only
}

export class DraftError extends Error {}

interface ModelAnswer { kind: CardKind; yaml: string; summary: string; assumptions: string[]; question: string }
const MAX_TRIES = 3;

export class Drafter {
  readonly model: string;
  private readonly o: DrafterOptions;
  private readonly client: Anthropic;

  constructor(o: DrafterOptions) {
    this.o = o;
    this.model = o.model;
    this.client = new Anthropic({
      apiKey: o.apiKey, timeout: 120_000, maxRetries: 1,
      ...(o.baseURL ? { baseURL: o.baseURL } : {}),
      ...(o.workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': o.workspaceId } } : {}),
    });
  }

  async draft(request: string, house: HouseContext): Promise<DraftResult> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: `${houseText(house)}\n\nПросьба: ${request}` }];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (let attempt = 1; ; attempt++) {
      const res = await this.ask(messages);
      usage.input += res.usage.input_tokens;
      usage.output += res.usage.output_tokens;
      usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
      const answer = parseAnswer(res);
      const base = { kind: answer.kind, summary: answer.summary, assumptions: answer.assumptions, attempts: attempt, usage };
      if (!answer.yaml.trim()) {
        return { ...base, yaml: '', card: null, question: answer.question || 'Claude не понял просьбу — опиши подробнее.', check: null };
      }
      const check = this.o.check(answer.kind, answer.yaml);
      const done = check.ok && !check.warnings.length;
      if (done || attempt >= MAX_TRIES) return { ...base, yaml: answer.yaml, card: check.raw, question: null, check };
      // Append-only: the model's turn as it came, then what the check found.
      messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
      const found = [
        ...check.issues.map((i) => `- ошибка${i.path ? ` в ${i.path}` : ''}: ${i.message}`),
        ...check.warnings.map((w) => `- предупреждение: ${w}`),
      ].join('\n');
      messages.push({ role: 'user', content: `Проверка карточки нашла:\n${found}\nИсправь и верни карточку целиком в том же формате.` });
    }
  }

  private async ask(messages: Anthropic.Beta.BetaMessageParam[]): Promise<Anthropic.Beta.BetaMessage> {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create({
        model: this.o.model,
        max_tokens: 16000,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages,
        output_config: { effort: this.o.effort, format: { type: 'json_schema', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
        // A declined request is retried server-side on Anthropic's recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (err) {
      throw new DraftError(apiErrorText(err));
    }
    if (res.stop_reason === 'refusal') throw new DraftError('Claude отказался писать такой черновик — переформулируй просьбу.');
    if (res.stop_reason === 'max_tokens') throw new DraftError('Ответ Claude не поместился — попробуй описать правило короче.');
    return res;
  }
}

function parseAnswer(res: Anthropic.Beta.BetaMessage): ModelAnswer {
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  let data: Partial<ModelAnswer>;
  try { data = JSON.parse(text) as Partial<ModelAnswer>; } catch { throw new DraftError('Claude ответил не в том формате — попробуй ещё раз.'); }
  return {
    kind: data.kind === 'scene' ? 'scene' : 'rule',
    yaml: typeof data.yaml === 'string' ? data.yaml.replace(/^```(?:ya?ml)?\n|```\s*$/g, '') : '',
    summary: typeof data.summary === 'string' ? data.summary : '',
    assumptions: Array.isArray(data.assumptions) ? data.assumptions.filter((a): a is string => typeof a === 'string') : [],
    question: typeof data.question === 'string' ? data.question.trim() : '',
  };
}

// The API's own sentence from the error body, not the SDK's "400 {json}".
const apiMessage = (err: InstanceType<typeof Anthropic.APIError>) =>
  (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;

function apiErrorText(err: unknown): string {
  if (err instanceof Anthropic.APIError && /not scoped to a workspace/i.test(apiMessage(err))) {
    return 'Ключ Claude API создан без рабочего пространства (workspace). Добавь в .env строку ANTHROPIC_WORKSPACE_ID=… с ID рабочего пространства из Claude Console (раздел Workspaces) или создай ключ внутри рабочего пространства — и перезапусти движок.';
  }
  if (err instanceof Anthropic.AuthenticationError) return 'Claude API не принял ключ — проверь ANTHROPIC_API_KEY.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'У ключа нет доступа к этой модели Claude.';
  if (err instanceof Anthropic.RateLimitError) return 'Claude API: слишком много запросов — попробуй через минуту.';
  if (err instanceof Anthropic.BadRequestError) return `Claude API отклонил запрос: ${apiMessage(err)}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Нет связи с Claude API — проверь интернет.';
  if (err instanceof Anthropic.APIError) return `Claude API: ошибка ${err.status ?? ''} — попробуй позже.`;
  return `Не получилось спросить Claude: ${(err as Error).message}`;
}
