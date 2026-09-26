#!/usr/bin/env node
// JSON and SQLite steps of scripts/deploy-live.sh. Pure functions are exported
// for the unit tests; the CLI below is what the shell script calls.

'use strict';

const fs = require('fs');
const path = require('path');

const AGENT_PANEL_TYPES = new Set(['claude-code', 'codex-cli', 'grok-cli']);

// b428f4d1 serves GET /api/cli/tabs without `cliState`; later servers always
// carry the key (null when unknown).
const listShape = (tabs) =>
  tabs.some((tab) => Object.prototype.hasOwnProperty.call(tab, 'cliState')) ? 'new' : 'old';

const agentTabs = (tabs) => tabs.filter((tab) => AGENT_PANEL_TYPES.has(tab.panelType));

const isExcluded = (tab, ownTabId, ignore) =>
  tab.tabId === ownTabId || ignore.includes(`${tab.workspaceId}/${tab.tabId}`);

/**
 * Agent tabs that are mid-turn. New shape: `busy` with a last event other than
 * `stop` (a tab kept busy only by open background work after a stop is not
 * mid-turn). Old shape: the per-tab status is the only state there is, so every
 * `busy` counts, and a status that could not be read counts too.
 */
const midTurnTabs = ({ tabs, statuses, ownTabId, ignore, now }) => {
  const shape = listShape(tabs);
  const result = [];
  for (const tab of agentTabs(tabs)) {
    if (isExcluded(tab, ownTabId, ignore)) continue;
    const entry = { workspaceId: tab.workspaceId, tabId: tab.tabId, name: tab.name, busyForS: null };
    if (shape === 'new') {
      if (tab.cliState !== 'busy' || tab.lastEvent?.name === 'stop') continue;
      if (typeof tab.busySince === 'number') entry.busyForS = Math.max(0, Math.round((now - tab.busySince) / 1000));
      result.push({ ...entry, reason: 'busy' });
      continue;
    }
    const status = statuses[tab.tabId];
    if (status?.gone) continue;
    if (!status || status.error) {
      result.push({ ...entry, reason: `status unreadable: ${status?.error ?? 'missing'}` });
      continue;
    }
    if (status.cliState === 'busy') result.push({ ...entry, reason: 'busy' });
  }
  return result;
};

const pickWorkspaceToken = (tabs, tokens) => {
  const withTabs = [...new Set(tabs.map((tab) => tab.workspaceId))].find((id) => tokens[id]);
  const workspaceId = withTabs ?? Object.keys(tokens)[0];
  return workspaceId ? { workspaceId, token: tokens[workspaceId] } : null;
};

// The live server keeps most rows in the WAL, so a plain copy of the main file
// loses them; the backup API reads through the WAL.
const backupSqlite = async (src, dst, modulePath) => {
  const Database = require(modulePath);
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dst);
  } finally {
    db.close();
  }
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));

const readStatuses = (dir) => {
  const statuses = {};
  if (!dir || !fs.existsSync(dir)) return statuses;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) statuses[name.slice(0, -5)] = readJson(path.join(dir, name));
  }
  return statuses;
};

const commands = {
  // shape TABS_JSON -> new|old
  shape: ([file]) => console.log(listShape(readJson(file).tabs ?? [])),
  // agent-tabs TABS_JSON -> "ws<TAB>tab" per agent tab
  'agent-tabs': ([file]) => {
    for (const tab of agentTabs(readJson(file).tabs ?? [])) console.log(`${tab.workspaceId}\t${tab.tabId}`);
  },
  // midturn TABS_JSON STATUS_DIR OWN_TAB [WS/TAB...] -> "ws<TAB>tab<TAB>name<TAB>busy-for<TAB>reason"
  midturn: ([file, statusDir, ownTabId, ...ignore]) => {
    const rows = midTurnTabs({
      tabs: readJson(file).tabs ?? [],
      statuses: readStatuses(statusDir),
      ownTabId: ownTabId || null,
      ignore,
      now: Date.now(),
    });
    for (const row of rows) {
      const busyFor = row.busyForS === null ? 'unknown' : `${row.busyForS}s`;
      console.log([row.workspaceId, row.tabId, row.name, busyFor, row.reason].join('\t'));
    }
  },
  // ws-token TABS_JSON TOKENS_JSON -> "ws<TAB>token" or nothing
  'ws-token': ([tabsFile, tokensFile]) => {
    const tokens = fs.existsSync(tokensFile) ? readJson(tokensFile) : {};
    const picked = pickWorkspaceToken(readJson(tabsFile).tabs ?? [], tokens);
    if (picked) console.log(`${picked.workspaceId}\t${picked.token}`);
  },
  // field JSON_FILE KEY -> the top-level value, or nothing
  field: ([file, key]) => {
    try {
      const value = readJson(file)[key];
      if (value !== undefined && value !== null) console.log(String(value));
    } catch {
      // not JSON: print nothing
    }
  },
  // backup SRC DST BETTER_SQLITE3_MODULE
  backup: ([src, dst, modulePath]) => backupSqlite(src, dst, modulePath),
};

if (require.main === module) {
  const [name, ...args] = process.argv.slice(2);
  const command = commands[name];
  if (!command) {
    process.stderr.write(`usage: deploy-live-helpers.cjs ${Object.keys(commands).join('|')} ...\n`);
    process.exit(2);
  }
  Promise.resolve()
    .then(() => command(args))
    .catch((err) => {
      process.stderr.write(`${name}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

module.exports = { listShape, agentTabs, midTurnTabs, pickWorkspaceToken, backupSqlite };
