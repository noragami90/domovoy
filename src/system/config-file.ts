// Edits of config.yaml from the panel: the YAML document is changed in place, so comments and
// layout survive; the result is validated like at start and written atomically.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import YAML, { isScalar, isSeq } from 'yaml';
import { checkConfig } from '../config.ts';

export type ConfigEdit = (doc: YAML.Document) => void;

export function editConfigFile(path: string, ...edits: ConfigEdit[]): void {
  const doc = YAML.parseDocument(readFileSync(path, 'utf8'));
  for (const e of edits) e(doc);
  const problem = checkConfig(doc.toJS());
  if (problem) throw new Error(`настройки не сохранены: ${problem}`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, doc.toString({ lineWidth: 0 })); // default padding: untouched lines keep their «{ a: 1 }» look
  renameSync(tmp, path);
}

// A list keeps its style ([1, 2] stays on one line) and the comment next to it.
export const setList = (path: (string | number)[], values: unknown[]): ConfigEdit => (doc) => {
  const node = doc.getIn(path, true);
  if (isSeq(node)) node.items = values.map((v) => doc.createNode(v));
  else {
    const seq = doc.createNode(values);
    if (isSeq(seq)) seq.flow = true;
    doc.setIn(path, seq);
  }
};

// A scalar keeps the comment on its line.
export const setValue = (path: (string | number)[], value: unknown): ConfigEdit => (doc) => {
  const node = doc.getIn(path, true);
  if (value === null || value === undefined) { if (doc.hasIn(path)) doc.deleteIn(path); return; }
  if (isScalar(node)) node.value = value;
  else doc.setIn(path, value);
};
