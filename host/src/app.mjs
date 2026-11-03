import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Sessions } from "./sessions.mjs";
import { EventStore } from "./events.mjs";
import { WorkQueue } from "./queue.mjs";
import { createPlugins } from "./plugins.mjs";
import { Templates, promptRegistry, preparePrompt } from "./context.mjs";
import { Skills } from "./skills.mjs";
import { localTools } from "./tools.mjs";
import { runTurn } from "./turns.mjs";

export async function createApplication(
  dataDir,
  {
    writer,
    templates = new Templates({
      system: "Repair the project and verify the change.",
    }),
  } = {},
) {
  const sessions = new Sessions(dataDir),
    events = new EventStore(join(dataDir, "events.jsonl")),
    queue = new WorkQueue(join(dataDir, "queue.jsonl"));
  const plugins = await createPlugins(),
    prompts = await promptRegistry();
  const controllers = new Map(),
    completions = new Map();
  let closing = false;
  return {
    sessions,
    events,
    queue,
    plugins,
    templates,
    async run(
      sessionId,
      text,
      {
        model,
        rules,
        queueItem,
        maxTurns,
        signal,
        allowTools,
        skillPaths = [],
        hooks,
        sandboxRequired = false,
      } = {},
    ) {
      if (closing) throw Error("application closing");
      const turnId = randomUUID(),
        release = sessions.admit(sessionId, turnId),
        controller = new AbortController();
      let done;
      const completion = new Promise((resolve) => {
        done = resolve;
      });
      completions.set(turnId, completion);
      controllers.set(sessionId, controller);
      let capabilities;
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        if (!prompts.reserve(turnId))
          throw Error("prompt preparation capacity exhausted");
        const snapshot = templates.capture();
        prompts.remember(turnId, { source: templates, snapshot });
        capabilities = await plugins.capture();
        const scope = prompts.take(turnId);
        if (!scope) throw Error("prompt scope missing");
        const prompt = preparePrompt(scope.source, scope.snapshot);
        const session = sessions.get(sessionId);
        const definitions = [
          ...localTools(session.workspaceDir),
          ...capabilities.tools,
        ];
        if (skillPaths.length) {
          const skills = new Skills(session.workspaceDir, skillPaths);
          definitions.push({
            name: "skill",
            source: "configured",
            readOnly: true,
            validate(input) {
              skills.load(input.name);
            },
            execute(input) {
              const skill = skills.load(input.name);
              return {
                text: skill.body,
                details: { allowedTools: skill.allowedTools, fork: skill.fork },
              };
            },
          });
        }
        if (queueItem) queue.accept(queueItem.id, turnId);
        const result = await runTurn({
          sessionId,
          turnId,
          text,
          model,
          rules,
          maxTurns,
          prompt,
          hooks,
          sandboxRequired,
          signal: controller.signal,
          root: session.workspaceDir,
          history: sessions.history(sessionId),
          tools: allowTools
            ? definitions.filter((t) => allowTools.includes(t.name))
            : definitions,
          write: async (frame) => {
            events.append(frame);
            await writer?.(frame);
          },
          persist: (messages) => sessions.append(sessionId, turnId, messages),
        });
        if (queueItem && result.delivered && result.persisted)
          queue.consume(queueItem.id);
        return { turnId, capabilityRevision: capabilities.revision, ...result };
      } finally {
        signal?.removeEventListener("abort", abort);
        prompts.discard(turnId);
        capabilities?.release();
        controllers.delete(sessionId);
        release();
        completions.delete(turnId);
        done();
      }
    },
    cancel(sessionId) {
      const controller = controllers.get(sessionId);
      if (!controller) return false;
      controller.abort(Error("user cancelled"));
      return true;
    },
    async next(sessionId, options) {
      if (sessions.active.has(sessionId)) throw Error("session busy");
      const item = queue.claim(sessionId);
      return item
        ? this.run(sessionId, item.text, { ...options, queueItem: item })
        : undefined;
    },
    async close() {
      closing = true;
      for (const controller of controllers.values()) controller.abort();
      await Promise.all([...completions.values()]);
      prompts.close();
      await plugins.close();
    },
  };
}
