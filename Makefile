.PHONY: precommit

precommit:
	pnpm lint
	pnpm tsc --noEmit
	pnpm exec vitest run --maxWorkers=4
