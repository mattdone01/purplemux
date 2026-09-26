// The server is not a tab. Started from inside one (`pnpm dev` in a tab's
// shell), it would carry that tab's identity and hand it to everything it
// spawns — the tmux server included — so closing that tab would reap the
// server's own children (ADR-0016, story 16 review). Drop it first, before
// anything is captured or spawned.
export const TAB_IDENTITY_ENV_KEYS = ['PMUX_TAB_ID', 'PMUX_TAB_TOKEN', 'PMUX_WORKSPACE_ID'] as const;

for (const key of TAB_IDENTITY_ENV_KEYS) delete process.env[key];

const cached = process.env.__PMUX_PRISTINE_ENV;

const withoutTabIdentity = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy = { ...env };
  for (const key of TAB_IDENTITY_ENV_KEYS) delete copy[key];
  return copy;
};

export const PRISTINE_ENV: NodeJS.ProcessEnv = Object.freeze(
  withoutTabIdentity(cached ? (JSON.parse(cached) as NodeJS.ProcessEnv) : { ...process.env }),
);

if (!cached) {
  process.env.__PMUX_PRISTINE_ENV = JSON.stringify(PRISTINE_ENV);
}
