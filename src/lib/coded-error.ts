/**
 * Whether `err` is a coded refusal of the class named `name`, judged by its brand, not `instanceof`.
 *
 * server.ts builds some singletons at boot (the watch manager, the notes service) and keeps them on
 * `globalThis`; the API routes are a separate Next bundle with their own copy of each module. An error
 * the singleton throws is an instance of the server graph's class, so a route's `instanceof` fails and
 * every refusal became a 500 (story 35, found by the wave-3 acceptance run). The class sets `name`.
 */
export const isCodedError = <T extends Error & { code: string }>(err: unknown, name: string): err is T =>
  err instanceof Error && err.name === name && typeof (err as { code?: unknown }).code === 'string';
