import { importSource } from "../../lab/source.mjs";
import { StdioRpc } from "../../runtime/rpc.mjs";

export async function createPlugins() {
  const { PluginCapabilityGenerationRegistry } = await importSource(
    "packages/local-runtime-v2/src/service/plugin-system/mcp/generation-registry.ts",
  );
  let current = "empty",
    pending = Promise.resolve();
  const views = new Map([["empty", []]]);
  const registry = new PluginCapabilityGenerationRegistry(current, {
    close: async () => {},
  });
  return {
    update(revision, discover) {
      pending = pending
        .catch(() => {})
        .then(async () => {
          if (views.has(revision)) throw Error("duplicate capability revision");
          const runtime = await discover(); // Discovery completes before publication.
          const retired = current;
          views.set(revision, runtime.tools);
          registry.replace(revision, runtime, async () => {
            views.delete(retired);
          });
          current = revision;
        });
      return pending;
    },
    async capture() {
      await pending;
      const revision = current,
        tools = views.get(revision);
      registry.retain(revision);
      let released = false;
      return {
        revision,
        tools,
        release() {
          if (!released) registry.release(revision);
          released = true;
        },
      };
    },
    async close() {
      try {
        await pending;
      } finally {
        await registry.dispose();
      }
    },
  };
}
export async function mcpRuntime(command, args) {
  const peer = new StdioRpc(command, args);
  try {
    await peer.initialize();
    const { tools } = await peer.request("tools/list");
    return {
      close: () => peer.close(),
      tools: tools.map((tool) => ({
        name: `mcp_${tool.name}`,
        source: "configured",
        schema: tool.inputSchema,
        validate(input) {
          if (typeof input.text !== "string") throw Error("text required");
        },
        async execute(input) {
          const result = await peer.request("tools/call", {
            name: tool.name,
            arguments: input,
          });
          return {
            text: result.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n"),
            isError: result.isError,
          };
        },
      })),
    };
  } catch (error) {
    await peer.close();
    throw error;
  }
}
