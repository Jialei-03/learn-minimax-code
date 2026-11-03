// A course-owned host, not MiniMax's production host. Compose real pinned
// upstream registries/SDK accumulator with synthetic events and in-memory IO.
import assert from 'node:assert/strict';
import { importSource } from '../lab/source.mjs';

export async function runHostLifecycle() {
  const { BoundedInternalTurnPromptReadRegistry } = await importSource('packages/agent-core/src/prompt-read.ts');
  const { PluginCapabilityGenerationRegistry } = await importSource('packages/local-runtime-v2/src/service/plugin-system/mcp/generation-registry.ts');
  const { ItemAccumulator } = await importSource('packages/code-sdk/src/items.ts');
  const prompts = new BoundedInternalTurnPromptReadRegistry(1);
  const closed = [];
  const generations = new PluginCapabilityGenerationRegistry('r1', { close: async () => { closed.push('r1'); } });
  let revision = 'r1';
  let active;
  const turns = new Map();
  const timeline = [];
  const record = (phase, note) => timeline.push({ phase, active: active?.id ?? null, revision, closed: [...closed], note });
  const admit = id => {
    if (active) throw new Error('session-busy');
    assert(prompts.reserve(id));
    const scope = { source: { kind: 'synthetic-prompt-source' }, snapshot: { revision } };
    prompts.remember(id, scope);
    assert.equal(prompts.take(id), scope);
    assert.equal(prompts.take(id), undefined);
    generations.retain(revision);
    active = { id, revision, accumulator: new ItemAccumulator(), signal: new AbortController() };
    turns.set(id, active);
    record('admitted', `教学宿主接纳 ${id}，持有 ${revision} 租约与同一次提示读取。`);
  };
  const deliver = (turnId, type, content) => {
    if (active?.id !== turnId) { record('stale-event-ignored', `${turnId} 的迟到事件没有写入当前 Turn。`); return false; }
    const event = { type, item: { id: `${turnId}:answer`, type: 'agent_message', ...content } };
    active.accumulator.apply(event);
    return true;
  };
  const finish = async pendingDelivery => {
    const turn = active;
    assert(turn);
    record('draining', `等待 ${turn.id} 已排队的交付，busy 尚未释放。`);
    await pendingDelivery;
    generations.release(turn.revision);
    active = undefined;
    record(turn.signal.signal.aborted ? 'aborted' : 'completed', `${turn.id} 收尾完成后再释放 busy。`);
  };
  try {
    admit('A');
    deliver('A', 'item.started', {});
    deliver('A', 'item.updated', { contentDelta: 'partial' });
    revision = 'r2';
    generations.replace('r2', { close: async () => { closed.push('r2'); } });
    assert.deepEqual(closed, []);
    record('hot-reload', 'R2 已发布；A 仍持有 R1，因此旧 runtime 尚未关闭。');
    active.signal.abort();
    record('cancel-requested', '取消意图已到达，但事件交付和 busy 收尾还没结束。');
    assert.throws(() => admit('B'), /session-busy/);
    record('early-admission-rejected', '此时直接开始 B 会越过 A 的收尾，因此教学宿主拒绝。');
    let releaseDelivery;
    const delivery = new Promise(resolve => { releaseDelivery = resolve; });
    const finishingA = finish(delivery);
    assert.equal(active.id, 'A');
    releaseDelivery();
    await finishingA;
    assert.deepEqual(closed, ['r1']);
    assert.equal(turns.get('A').accumulator.items()[0].incomplete, true);
    admit('B');
    assert.equal(deliver('A', 'item.updated', { contentDelta: 'late' }), false);
    deliver('B', 'item.started', {});
    deliver('B', 'item.updated', { content: 'tests passed' });
    deliver('B', 'item.completed', { content: 'tests passed' });
    await finish(Promise.resolve());
    assert.equal(turns.get('B').accumulator.items()[0].text, 'tests passed');
    assert.equal(turns.get('B').accumulator.items()[0].incomplete, undefined);
    await generations.dispose();
    assert.deepEqual(closed, ['r1', 'r2']);
    record('disposed', '所有工作完成，最后关闭当前 runtime。');
    return {
      contract: 'course-owned host composes three real upstream components',
      oldGenerationSurvivedHotReload: true, busyReleasedAfterDrain: true,
      staleEventDidNotContaminateNextTurn: true,
      A: turns.get('A').accumulator.items(), B: turns.get('B').accumulator.items(), timeline,
      evidence: '课程自写宿主 + 完整上游 PromptRegistry、GenerationRegistry、ItemAccumulator；事件与 close 均为合成端口，不是生产 Session/Turn 集成运行',
    };
  } finally {
    prompts.close();
    await generations.dispose();
  }
}
