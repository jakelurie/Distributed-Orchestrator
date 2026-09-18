import assert from 'node:assert/strict';
import { recoverStoppedTurn, sessionWriteError } from '../src/core/cluster/execution.js';
const current = { id: 's', ownerNode: 'b', turnHost: 'b', turnStartedAt: 10,
  executionEpoch: 4, tabWorkspace: { dir: '/owner/worktree', ownerNode: 'b' },
  events: [{ type: 'assistant', text: 'unfinished' }] };
const recovered = recoverStoppedTurn(current, current, { type: 'note', text: 'interrupted' });
assert.equal(recovered.turnHost, undefined);
assert.equal(recovered.executionEpoch, 5);
assert.deepEqual(recovered.tabWorkspace, current.tabWorkspace);
assert.equal(current.turnHost, 'b', 'recovery does not mutate the observed snapshot');
assert.equal(recovered.events.length, 2);
assert.equal(recoverStoppedTurn(recovered, current, {}), undefined, 'recovery is idempotent');
assert.equal(recoverStoppedTurn({ ...current, turnStartedAt: 11 }, current, {}), undefined);
assert.equal(recoverStoppedTurn({ ...current, executionEpoch: 5 }, current, {}), undefined);
assert.match(sessionWriteError(recovered, current), /stale/);
console.log('PASS recovery preserves owner work, refuses stale turns and is idempotent');
