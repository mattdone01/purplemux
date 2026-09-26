/**
 * Coded refusals recognised by a brand, not by `instanceof` (story 35).
 *
 * server.ts builds some singletons at boot (the watch manager, the notes service) and keeps them on
 * `globalThis`; the API routes are a separate Next bundle with their own copy of each module. An error
 * the singleton throws is an instance of the server graph's class, so a route's `instanceof` fails and
 * every refusal became a 500 (found by the wave-3 acceptance run). `Symbol.for` is shared by every
 * module graph in the realm, as `mission-control-errors.ts` already relies on.
 */
const brandOf = (name: string): symbol => Symbol.for(`purplemux.coded-error.${name}`);

/** Mark a coded error as class `name`; call it in the class constructor. */
export const brandCodedError = (err: Error, name: string): void => {
  Object.defineProperty(err, brandOf(name), { value: true });
  err.name = name;
};

/** A branded error of class `name` whose code is one the route maps (`codes` is its status table). */
export const isCodedError = <T extends Error & { code: string }>(
  err: unknown,
  name: string,
  codes: Readonly<Record<string, unknown>>,
): err is T => {
  if (!(err instanceof Error) || (err as unknown as Record<symbol, unknown>)[brandOf(name)] !== true) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(codes, code);
};
