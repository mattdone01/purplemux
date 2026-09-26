import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// Story 20: the coordination panel renders in the browser. A Node-only module
// (fs, os, path, child_process) anywhere in its value-import graph breaks
// `next build`, and the unit gate renders in Node, so nothing else catches it.

const SRC = path.resolve(__dirname, '../../../src');
const NODE_ONLY = /^(node:)?(fs|fs\/promises|os|path|child_process|net|tls|crypto)$/;
const VALUE_IMPORT = /^\s*import\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

const resolveAlias = (spec: string): string | null => {
  const base = path.join(SRC, spec.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

/** Every `@/` file reachable by value imports from `entry`, and every Node-only import met on the way. */
const walk = (entry: string): { files: string[]; nodeOnly: string[] } => {
  const seen = new Set<string>();
  const nodeOnly: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of fs.readFileSync(file, 'utf-8').matchAll(VALUE_IMPORT)) {
      if (NODE_ONLY.test(spec)) nodeOnly.push(`${path.relative(SRC, file)} imports ${spec}`);
      if (!spec.startsWith('@/')) continue;
      const resolved = resolveAlias(spec);
      if (resolved) queue.push(resolved);
    }
  }
  return { files: [...seen].map((f) => path.relative(SRC, f)), nodeOnly };
};

describe('coordination panel client import graph', () => {
  it('reaches no Node-only module', () => {
    const { files, nodeOnly } = walk(path.join(SRC, 'components/features/mission-control/coordination-panel.tsx'));
    expect(files).toContain('lib/host-warnings.ts');
    expect(nodeOnly).toEqual([]);
  });

  it('the walker sees a Node-only import (host-metrics is server-side)', () => {
    expect(walk(path.join(SRC, 'lib/host-metrics.ts')).nodeOnly).toEqual(expect.arrayContaining(['lib/host-metrics.ts imports fs/promises']));
  });
});
