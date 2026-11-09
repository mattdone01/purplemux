// Add, rotate or revoke a workspace-bound service sender (ADR-0044). Run it on the server host as the owner:
//   npx tsx scripts/service-sender-grant.ts --name improve-lessons --workspace ws-A --note-to ws-B --token-file PATH
//   npx tsx scripts/service-sender-grant.ts --revoke improve-lessons
// The token goes only to --token-file (mode 0600). This script never prints it.
import { grantServiceSender, revokeServiceSender, serviceSendersFile } from '../src/lib/service-senders';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const main = (): number => {
  const revoke = arg('--revoke');
  if (revoke) {
    const removed = revokeServiceSender(revoke);
    console.log(removed ? `revoked ${revoke} in ${serviceSendersFile()}` : `no service sender ${revoke}`);
    return removed ? 0 : 1;
  }
  const name = arg('--name');
  const workspaceId = arg('--workspace');
  const noteTarget = arg('--note-to');
  const tokenFile = arg('--token-file');
  if (!name || !workspaceId || !noteTarget || !tokenFile) {
    console.error('usage: --name N --workspace WS --note-to WS --token-file PATH | --revoke N');
    return 2;
  }
  const grant = grantServiceSender({ name, workspaceId, noteTarget }, tokenFile);
  console.log(`granted ${grant.name}: home ${grant.workspaceId}, may note ${grant.noteTarget}; token written to ${tokenFile}`);
  return 0;
};

process.exitCode = main();
