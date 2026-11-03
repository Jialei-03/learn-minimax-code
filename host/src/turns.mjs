import { SerialDelivery } from "./events.mjs";
import { historyCursor } from "./history.mjs";
import { projectMessages } from "./context.mjs";
import { toolCatalogue, wrapTool } from "./tools.mjs";

export async function runTurn({
  sessionId,
  turnId,
  text,
  history = [],
  model,
  tools = [],
  root,
  signal,
  write,
  persist,
  rules = {},
  prompt,
  hooks = {},
  maxTurns = 8,
  sandboxRequired = false,
}) {
  const delivery = new SerialDelivery(write),
    messages = structuredClone(history),
    catalogue = toolCatalogue(tools);
  const cursor = historyCursor(messages.length, persist);
  let seq = 0,
    status = "completed",
    error;
  const emit = (frame) =>
    delivery.send({ ...frame, sessionId, turnId, seq: ++seq });
  try {
    messages.push({ role: "user", text });
    await emit({ type: "turn.started" });
    for (let iteration = 1; iteration <= maxTurns; iteration++) {
      signal?.throwIfAborted();
      const reply = await model(
        {
          system: prompt.system,
          messages: projectMessages(messages),
          tools: [...catalogue.values()].map((t) => ({
            name: t.name,
            schema: t.schema,
          })),
        },
        signal,
      );
      signal?.throwIfAborted();
      if (reply.stop === "length") throw Error("truncated kernel response");
      const item = { id: `${turnId}:${iteration}`, type: "agent_message" };
      await emit({ type: "item.started", item });
      if (reply.text)
        await emit({
          type: "item.updated",
          item: { ...item, contentDelta: reply.text },
        });
      messages.push({
        role: "assistant",
        text: reply.text ?? "",
        calls: reply.calls ?? [],
      });
      const execute = async (call) => {
        const definition = catalogue.get(call.name);
        if (!definition)
          return {
            role: "tool",
            id: call.id,
            text: "unknown tool",
            error: true,
          };
        return wrapTool(
          definition,
          {
            root,
            signal,
            sessionId,
            turnId,
            assistantMessageId: item.id,
            sandboxRequired,
          },
          { ...hooks, rules },
        )(call);
      };
      // Adjacent parallel runs cannot cross a sequential tool barrier.
      const calls = reply.calls ?? [];
      for (let i = 0; i < calls.length; ) {
        const group = [calls[i++]];
        if (catalogue.get(group[0].name)?.executionMode === "parallel")
          while (
            i < calls.length &&
            catalogue.get(calls[i].name)?.executionMode === "parallel"
          )
            group.push(calls[i++]);
        messages.push(...(await Promise.all(group.map(execute))));
      }
      await cursor.flush(messages);
      signal?.throwIfAborted();
      await emit({
        type: "item.completed",
        item: { ...item, content: reply.text ?? "" },
      });
      if (!calls.length) break;
      if (iteration === maxTurns) status = "budget";
    }
  } catch (caught) {
    status = signal?.aborted ? "cancelled" : "failed";
    error = String(caught.message ?? caught);
  }
  // Terminal delivery cannot overtake queued data or failed persistence.
  try {
    await delivery.drain();
    await cursor.flush(messages);
    await emit({ type: "turn.completed", status, ...(error ? { error } : {}) });
    await delivery.drain();
  } catch (caught) {
    status = "failed";
    error = String(caught.message ?? caught);
  }
  return {
    status,
    error,
    messages,
    persisted: !cursor.failed,
    delivered: !delivery.error,
    seq,
  };
}
