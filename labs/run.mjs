import assert from 'node:assert/strict';
import { readSource, importSource, LOCK } from '../lab/source.mjs';

const cases = {
  architecture: async () => {
    const extraction = JSON.parse(readSource('release/extraction.json'));
    const root = JSON.parse(readSource('package.json'));
    const thirdParty = extraction.packageRoots.filter(p => p.startsWith('third_party/'));
    assert(extraction.packageRoots.includes('packages/local-runtime-v2'));
    assert(thirdParty.some(p => p.includes('pi-mono')));
    return { version: root.version, packages: extraction.packageRoots.length, thirdParty,
      entry: 'TUI / exec / ACP → CliService → Applications → Session / Turn / Agent → Pi / tools',
      evidence: '真实发布契约的静态分析；不是一次模型运行' };
  },
  sdk: async () => {
    const { ItemAccumulator } = await importSource('packages/code-sdk/src/items.ts');
    const acc = new ItemAccumulator();
    const event = (type, id, extra = {}) => ({ type, item: { id, type: 'agent_message', ...extra } });
    acc.apply(event('item.started', 'a'));
    acc.apply(event('item.updated', 'a', { contentDelta: 'ha' }));
    acc.apply(event('item.updated', 'b', { content: 'other' }));
    acc.apply(event('item.updated', 'a', { contentDelta: 'ha' }));
    const snapshot = event('item.updated', 'a', { content: 'haha' });
    assert.equal(acc.apply(snapshot), true);
    assert.equal(acc.apply(snapshot), false);
    acc.apply(event('item.completed', 'a', { content: 'haha' }));
    const items = acc.items();
    assert.equal(items[0].text, 'haha');
    assert.equal(items[0].incomplete, undefined);
    assert.equal(items[1].incomplete, true);
    return { items, duplicateSnapshotEmitted: false, repeatedDeltaRetained: true,
      evidence: '直接执行上游完整 ItemAccumulator；合成事件，未启动 CLI' };
  },
  registry: async () => {
    const { BoundedInternalTurnPromptReadRegistry } = await importSource('packages/agent-core/src/prompt-read.ts');
    const registry = new BoundedInternalTurnPromptReadRegistry(1);
    const scope = { source: {}, snapshot: {} }; // Opaque test identity; no model requests.
    assert.equal(registry.reserve('first'), true);
    assert.equal(registry.reserve('second'), false);
    registry.remember('first', scope);
    assert.equal(registry.rebind('first', 'renamed'), true);
    assert.equal(registry.take('first'), undefined);
    assert.equal(registry.take('renamed'), scope);
    assert.equal(registry.take('renamed'), undefined);
    assert.equal(registry.reserve('second'), true);
    registry.close();
    assert.equal(registry.reserve('after-close'), false);
    return { capacityIncludesReservations: true, rebindPreservesIdentity: true, takeIsDestructive: true, closedRejectsReservations: true,
      evidence: '直接执行上游完整 Registry；验证进程内交接，未验证持久恢复' };
  },
  usage: async () => {
    const { SessionUsageService, SessionUsageServiceError } = await importSource('packages/local-runtime-v2/src/service/session-system/usage/service.ts');
    const calls = [];
    const store = {
      summarizeBySession: async (...args) => { calls.push(['summary', ...args]); return { totalTokens: 5 }; },
      listBySession: async (...args) => { calls.push(['rows', ...args]); return []; },
      summarizeGlobal: async (...args) => { calls.push(['global', ...args]); return {}; },
      summarizeGroupBy: async (...args) => { calls.push(['group', ...args]); return []; },
    };
    const service = new SessionUsageService(store);
    await service.readSession({ sessionId: 'synthetic', from: 0, to: 10 });
    assert.deepEqual(calls[0], ['summary', 'synthetic', { from: 0, to: 10 }]);
    const rejected = [];
    for (const [input, reason] of [
      [{ from: -1 }, 'invalid-from'], [{ from: 0.5 }, 'invalid-from'],
      [{ to: Infinity }, 'invalid-to'], [{ from: 9, to: 2 }, 'invalid-range'],
      [{ group: 'provider' }, 'invalid-group'],
    ]) {
      const before = calls.length;
      await assert.rejects(service.summarizeGlobal(input), e => e instanceof SessionUsageServiceError && e.reason === reason);
      assert.equal(calls.length, before);
      rejected.push(reason);
    }
    await service.summarizeGlobal({ group: 'model' });
    return { rejected, invalidInputReachedStore: false, validGroups: ['agent', 'session', 'model', 'day'],
      evidence: '直接执行上游 Service；存储端口是 fake，不代表 SQLite 读写验证' };
  },
  paths: async () => {
    const { isTuiAcpAbsolutePath } = await importSource('packages/tui/src/acp/paths.ts');
    const inputs = ['/tmp/project', 'C:\\work\\project', '\\\\server\\share', './relative', 'C:relative', '~/project'];
    const results = inputs.map(path => ({ path, absolute: isTuiAcpAbsolutePath(path) }));
    assert.deepEqual(results.map(x => x.absolute), [true, true, true, false, false, false]);
    return { results, evidence: '直接执行上游路径分类；绝对路径不等于被授权或已存在' };
  },
  checkpoint: async () => {
    const { CHECKPOINT_SYSTEM_PROMPT, parseCheckpointHeadings } = await importSource('packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/checkpoint-protocol.ts');
    const headings = parseCheckpointHeadings(CHECKPOINT_SYSTEM_PROMPT);
    assert.equal(headings.length, 8);
    assert.equal(headings[0], 'Goal');
    assert.equal(headings.at(-1), 'Critical Context & Relevant Files');
    assert.deepEqual(parseCheckpointHeadings('Example\n## Old\n\nProtocol:\n## Goal\n## State'), ['Goal', 'State']);
    assert.throws(() => parseCheckpointHeadings('no headings'), /no section heading list/);
    return { headings, trailingBlockIsProtocol: true, missingProtocolRejected: true,
      evidence: '直接执行上游 checkpoint 协议解析；未请求摘要模型，不能证明摘要质量' };
  },
};

export async function runLab(name) {
  if (!Object.hasOwn(cases, name)) throw new Error(`未知实验 ${name}；可选：${Object.keys(cases).join(', ')}`);
  return { lab: name, commit: LOCK.commit, ...(await cases[name]()) };
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const names = process.argv[2] ? [process.argv[2]] : Object.keys(cases);
  for (const name of names) console.log(JSON.stringify(await runLab(name), null, 2));
}
