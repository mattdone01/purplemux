// Build-output check for scripts/post-build.js: did Next trace the whole project
// into .next/standalone?
//
// A path that Turbopack cannot scope to a folder — `path.join(dir, name)` with
// `dir` a function argument, in a module a Next route imports — makes the trace
// take every file under the project root (the build prints "Encountered
// unexpected file in NFT list" and still exits 0). Then the standalone tree holds
// a copy of `server.ts` beside `server.js`, and `tsx server.ts` resolves
// `require('.next/standalone/server.js')` to that copy: the Next server never
// starts, and server.ts times out on its port. A release with any of these
// root-only files must fail its build, not its acceptance run.

'use strict';

const fs = require('fs');
const path = require('path');

/** Root files no traced route reads at runtime; one in the standalone tree marks a whole-project trace. */
const ROOT_ONLY_FILES = [
  'server.ts',
  'next.config.ts',
  'tsconfig.json',
  'pnpm-lock.yaml',
  'vitest.config.ts',
  'eslint.config.mjs',
];

/** The ROOT_ONLY_FILES present at the top of `standaloneDir`, in list order. */
const wholeProjectTraceMarkers = (standaloneDir) =>
  ROOT_ONLY_FILES.filter((name) => fs.existsSync(path.join(standaloneDir, name)));

/** Null when the tree is clean; otherwise the refusal text, measured beside expected. */
const describeWholeProjectTrace = (standaloneDir) => {
  const found = wholeProjectTraceMarkers(standaloneDir);
  if (found.length === 0) return null;
  const entries = fs.readdirSync(standaloneDir).sort();
  return [
    '[post-build] REFUSED WHOLE-PROJECT-TRACE: Next traced the whole project into .next/standalone',
    `  measured: root-only files ${JSON.stringify(found)}; ${entries.length} top-level entries ${JSON.stringify(entries)}`,
    `  expected: none of ${JSON.stringify(ROOT_ONLY_FILES)}`,
    '  fix: find the "Encountered unexpected file in NFT list" warning in the next build output and scope the',
    '       file operation in the last module of its import trace (never add a tracing exclude to hide it)',
  ].join('\n');
};

module.exports = { ROOT_ONLY_FILES, wholeProjectTraceMarkers, describeWholeProjectTrace };
