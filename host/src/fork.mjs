export async function forkTask(
  app,
  parentSessionId,
  task,
  { model, signal } = {},
) {
  const parent = app.sessions.get(parentSessionId);
  const child = app.sessions.create(parent.workspaceDir);
  // Independent history and a genuinely smaller tool catalogue. The workspace
  // is shared; this is not a worktree or OS sandbox.
  const result = await app.run(child.id, task, {
    model,
    signal,
    allowTools: ["read"],
  });
  return { sessionId: child.id, ...result };
}
