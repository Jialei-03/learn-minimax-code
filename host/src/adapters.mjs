// Three input adapters deliberately share one application and its state owner.
export function adapters(app) {
  return {
    tui: (sessionId, text, options) => app.run(sessionId, text, options),
    exec: (request, options) =>
      app.run(request.sessionId, request.prompt, options),
    acp: (request, options) => {
      if (request.method !== "session/prompt")
        throw Error("unsupported ACP method");
      return app.run(request.params.sessionId, request.params.text, options);
    },
  };
}
