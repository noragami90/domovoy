// The rule diagram: conditions → timers → actions, with what holds right now.
// Built on the server (texts come from the same explanations as "why"); the page only draws it.
import { formatDuration } from '../duration.ts';
import { combine, type ItemResult, type ItemStatus } from '../engine/conditions.ts';
import type { Engine } from '../engine/engine.ts';
import { currentText, requirementText } from '../explain/explain.ts';
import { conditionsOf, modeOf, type Action, type Condition, type Rule, type Scene } from '../rules/schema.ts';

export interface DiagramCondition { text: string; now: string; status: ItemStatus; timer: string | null }
export interface DiagramAction { text: string; when: string[] }
export type Diagram =
  | {
    kind: 'rule'; mode: 'all' | 'any'; enabled: boolean; overall: ItemStatus; live: boolean;
    switch: { enabled: boolean; pausedUntil: number | null } | null; // the panel switch of the running rule
    conditions: DiagramCondition[]; then: DiagramAction[];
    otherwise: { after: string | null; do: DiagramAction[] } | null; cooldown: string | null;
  }
  | { kind: 'scene'; steps: DiagramAction[] };

function conditionNodes(items: ItemResult[], engine: Engine): DiagramCondition[] {
  return items.map((it) => ({
    text: requirementText(it, engine),
    now: currentText(it, engine),
    status: it.reason ? 'unknown' : it.status,
    timer: it.needForMs !== undefined ? formatDuration(it.needForMs) : null,
  }));
}

function actionNodes(list: Action[], engine: Engine): DiagramAction[] {
  return list.map((a) => {
    const scene = 'scene' in a ? engine.scenes.find((s) => s.id === a.scene) : undefined;
    const text = scene ? `Сцена «${scene.name}»` : engine.describeAction(a);
    const when = a.if ? engine.preview(a.if as Condition[]).map((it) => requirementText(it, engine)) : [];
    return { text: text.charAt(0).toUpperCase() + text.slice(1), when };
  });
}

export function buildDiagram(kind: 'rule' | 'scene', card: Rule | Scene, engine: Engine): Diagram {
  if (kind === 'scene') return { kind: 'scene', steps: actionNodes((card as Scene).do, engine) };
  const rule = card as Rule;
  // The running rule itself (saved, unchanged): its real waits. Otherwise a preview against the house now.
  const running = engine.rules.find((r) => r.id === rule.id);
  const live = !!running && JSON.stringify(running) === JSON.stringify(rule);
  const items = live ? engine.snapshot(running!).items : engine.preview(conditionsOf(rule));
  return {
    kind: 'rule', mode: modeOf(rule), enabled: rule.enabled, live,
    switch: running ? engine.ruleSwitch(running.id) : null,
    overall: combine(modeOf(rule), items),
    conditions: conditionNodes(items, engine),
    then: actionNodes(rule.then, engine),
    otherwise: rule.otherwise ? { after: rule.otherwise.after ? formatDuration(rule.otherwise.after) : null, do: actionNodes(rule.otherwise.do, engine) } : null,
    cooldown: rule.cooldown !== undefined ? formatDuration(rule.cooldown) : null,
  };
}
