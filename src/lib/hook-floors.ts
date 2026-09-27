import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '@/lib/logger';

const log = createLogger('hook-spool');

/** The floors file's name in the spool directory; the drain never treats it as a temporary. */
export const HOOK_FLOORS_FILENAME = '.floors.json';
/** A raised floor reaches the file at most this often (ADR-0020). */
export const HOOK_FLOORS_SAVE_MS = 5_000;

export interface IHookFloorStoreOptions {
  /** The spool directory; the file is `<dir>/.floors.json`. */
  dir: string;
  saveMs?: number;
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * Each tab's hook floor, persisted outside the layout (ADR-0020): one small
 * file `hook-spool/.floors.json` (tab id → epoch ms), replaced by one rename.
 *
 * A raise changes memory at once and reaches the file at most once per
 * `saveMs`, and on `flush` (the graceful shutdown awaits it). No sync message
 * and no layout write: a floor that is too low is harmless, because the spool
 * only holds events from after the server stopped answering.
 */
export class HookFloorStore {
  private readonly file: string;
  private readonly dir: string;
  private readonly saveMs: number;
  private floors = new Map<string, number>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: IHookFloorStoreOptions) {
    this.dir = options.dir;
    this.file = path.join(options.dir, HOOK_FLOORS_FILENAME);
    this.saveMs = options.saveMs ?? HOOK_FLOORS_SAVE_MS;
  }

  /** Read the file a previous server saved. Absent or unreadable: no floors, one log line. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf-8');
    } catch (err) {
      if (!isMissing(err)) log.warn({ err: String(err) }, 'hook floors unreadable: every tab starts without a floor');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      log.warn({ file: this.file }, 'hook floors file is not JSON: every tab starts without a floor');
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [tabId, at] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof at !== 'number' || !Number.isFinite(at)) continue;
      if (at > (this.floors.get(tabId) ?? -Infinity)) this.floors.set(tabId, at);
    }
  }

  get(tabId: string): number | undefined {
    return this.floors.get(tabId);
  }

  /** Raise the tab's floor; a lower value changes nothing. */
  raise(tabId: string, at: number): void {
    if (!Number.isFinite(at) || at <= (this.floors.get(tabId) ?? -Infinity)) return;
    this.floors.set(tabId, at);
    this.markDirty();
  }

  /** A closed tab's floor goes. */
  forget(tabId: string): void {
    if (this.floors.delete(tabId)) this.markDirty();
  }

  /** Keep only the floors of `tabIds` (after the boot scan: tabs closed while down go). */
  retain(tabIds: ReadonlySet<string>): void {
    let removed = false;
    for (const tabId of [...this.floors.keys()]) {
      if (!tabIds.has(tabId)) {
        this.floors.delete(tabId);
        removed = true;
      }
    }
    if (removed) this.markDirty();
  }

  /** Write the floors now if any changed since the last write; the shutdown path awaits it. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const snapshot = JSON.stringify(Object.fromEntries(this.floors));
    this.writing = this.writing.then(() => this.write(snapshot)).catch((err) => {
      log.warn({ err: String(err) }, 'hook floors not saved');
    });
    return this.writing;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.saveMs);
    this.timer.unref?.();
  }

  private async write(snapshot: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, `${HOOK_FLOORS_FILENAME}.${process.pid}.tmp`);
    try {
      await fs.writeFile(tmp, `${snapshot}\n`, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}
