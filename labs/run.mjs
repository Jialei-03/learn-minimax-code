import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { readSource, importSource, LOCK } from '../lab/source.mjs';

// Selected turn-driving functions keep their exact upstream bodies. Only the
// Agent and failure classification port are synthetic; no Pi/provider starts.
function turnDriver() {
  const text = readSource('packages/agent-core/src/pi-turn-runner/agent.ts');
  const functions = ['toPiUserMessage', 'repeatRecoveredRequest', 'runAgent'].map(name => {
    const expression = new RegExp(`(?:export )?(?:async )?function ${name}\\(`);
    const start = text.search(expression);
    const closing = /\n}[ \t]*(?=\r?\n|$)/g; closing.lastIndex = start;
    const end = closing.exec(text)?.index ?? -1;
    assert(start >= 0 && end > start);
    return text.slice(start, end + 2).replace(/^export /, '');
  }).join('\n');
  const code = stripTypeScriptTypes(functions, { mode: 'transform' });
  return vm.runInNewContext(`${code}\nrunAgent`, { failureReason: message => ({ kind: 'failed', message }) });
}

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
    const trace = [];
    const apply = input => {
      const accepted = acc.apply(input);
      trace.push({ event: input, accepted, items: structuredClone(acc.items()) });
      return accepted;
    };
    const event = (type, id, extra = {}) => ({ type, item: { id, type: 'agent_message', ...extra } });
    apply(event('item.started', 'a'));
    apply(event('item.updated', 'a', { contentDelta: 'ha' }));
    apply(event('item.updated', 'b', { content: 'other' }));
    apply(event('item.updated', 'a', { contentDelta: 'ha' }));
    const snapshot = event('item.updated', 'a', { content: 'haha' });
    assert.equal(apply(snapshot), true);
    assert.equal(apply(snapshot), false);
    apply(event('item.completed', 'a', { content: 'haha' }));
    const items = acc.items();
    assert.equal(items[0].text, 'haha');
    assert.equal(items[0].incomplete, undefined);
    assert.equal(items[1].incomplete, true);
    return { items, trace, duplicateSnapshotEmitted: false, repeatedDeltaRetained: true,
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
  generation: async () => {
    const { PluginCapabilityGenerationRegistry } = await importSource('packages/local-runtime-v2/src/service/plugin-system/mcp/generation-registry.ts');
    const log = [];
    const runtime = revision => ({ close: async () => { log.push(`close:${revision}`); } });
    const registry = new PluginCapabilityGenerationRegistry('r1', runtime('r1'));
    registry.retain('r1');
    registry.replace('r2', runtime('r2'), async () => { log.push('finalize:r1'); });
    assert.deepEqual(log, []);
    const leasedOldGenerationSurvivesReplace = true;
    registry.release('r1');
    await registry.dispose();
    assert.equal(log.filter(x => x === 'close:r1').length, 1);
    assert.equal(log.filter(x => x === 'close:r2').length, 1);
    assert(log.indexOf('finalize:r1') > log.indexOf('close:r1'));
    registry.release('r1');
    return { leasedOldGenerationSurvivesReplace, cleanupLog: log, eachRuntimeClosedOnce: true,
      evidence: '执行完整上游 generation、helpers、errors 模块；runtime.close 是 fake，未连接 MCP' };
  },
  queue: async () => {
    const { QueueService, QueueServiceError } = await importSource('packages/local-runtime-v2/src/service/session-system/queue/service.ts');
    const { QueueDataCorruptionError, QueueEnqueueAdmissionError } = await importSource('packages/local-runtime-v2/src/service/session-system/queue/repo/contract.ts');
    const calls = [];
    const committed = { value: { id: 'synthetic' }, facts: [{ type: 'synthetic-committed-fact' }] };
    const service = new QueueService({
      nowMs: () => 100,
      sessions: { get: async id => id === 'missing' ? undefined : { sessionId: id, runtime: id === 'unsupported' ? 'opencode' : 'local' } },
      isReadOnlySession: session => session.sessionId === 'readonly',
      store: {
        enqueue: async input => { calls.push(input); return committed; },
        list: async () => { throw new QueueDataCorruptionError('synthetic-session', 'synthetic-item'); },
        cancel: async session => { throw new QueueEnqueueAdmissionError(session, 'maintenance-active'); },
      },
    });
    for (const expiresAt of [99, 100, Infinity, NaN]) assert.throws(() => service.enqueue({ expiresAt }), e => e.reason === 'expiry-invalid');
    assert.equal(calls.length, 0);
    assert.equal(await service.enqueue({ expiresAt: 101 }), committed);
    const reasons = [];
    for (const id of ['missing', 'readonly', 'unsupported']) {
      await assert.rejects(service.requireMutableSession(id), e => { assert(e instanceof QueueServiceError); reasons.push(e.reason); return true; });
    }
    await assert.rejects(service.list('s'), e => e.reason === 'data-corrupt');
    await assert.rejects(service.cancel('s', 'i'), e => e.reason === 'session-busy');
    return { rejectedExpiryDidNotReachStore: true, committedResultPreservedByIdentity: true, reasons,
      evidence: '执行完整 QueueService、policy、contract；store 与会话读取是 fake，不验证事务或调度器' };
  },
  turn: async () => {
    const runAgent = turnDriver();
    const rows = [];
    for (const mode of ['prompt', 'continue', 'aborted', 'thrown']) {
      const calls = [];
      const agent = {
        state: {},
        prompt: async messages => { calls.push(`prompt:${messages.length}`); if (mode === 'thrown') throw Error('synthetic'); },
        continue: async () => { calls.push('continue'); },
        waitForIdle: async () => { calls.push('idle'); },
      };
      const turn = {
        input: { startMode: mode === 'continue' ? 'continue' : 'prompt', userMessage: { text: 'hello' }, signal: { aborted: mode === 'aborted' } },
        recovery: {}, metrics: { getLLMFailureObservation: () => undefined }, logger: { error: () => {} },
      };
      const reason = await runAgent(agent, turn, async () => { calls.push('converge'); });
      if (mode === 'aborted') assert.equal(reason.kind, 'aborted');
      else if (mode === 'thrown') assert.equal(reason.kind, 'failed');
      else assert.equal(reason, undefined);
      if (mode === 'continue') assert.equal(calls[0], 'continue');
      if (mode === 'prompt') assert(calls.indexOf('converge') < calls.lastIndexOf('idle'));
      rows.push({ mode, calls, reason: reason?.kind ?? 'normal-return' });
    }
    return { rows, evidence: '执行提取的上游 runAgent、repeatRecoveredRequest、toPiUserMessage；Agent 和错误分类端口是 fake，未验证 runner 事件 drain' };
  },
  capstone: async () => (await import('./host-lifecycle.mjs')).runHostLifecycle(),
};

export async function runLab(name) {
  if (!Object.hasOwn(cases, name)) throw new Error(`未知实验 ${name}；可选：${Object.keys(cases).join(', ')}`);
  return { lab: name, commit: LOCK.commit, ...(await cases[name]()) };
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const names = process.argv[2] ? [process.argv[2]] : Object.keys(cases);
  for (const name of names) console.log(JSON.stringify(await runLab(name), null, 2));
}
