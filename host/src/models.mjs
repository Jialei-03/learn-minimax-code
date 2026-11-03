export function parseModelKey(raw) {
  if (typeof raw !== "string") return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}
export class BudgetResolver {
  constructor() {
    this.retries = new WeakMap();
  }
  resolve(identity, request, { window, configuredMax = 512, thinking = 0 }) {
    if (this.retries.has(identity)) return this.retries.get(identity);
    const input = Math.ceil(JSON.stringify(request).length / 4);
    const maxTokens = Math.min(configuredMax, window - input);
    if (maxTokens < 1 || thinking < 0 || thinking >= maxTokens)
      throw Error("request budget exhausted");
    const budget = Object.freeze({ input, maxTokens, thinking });
    this.retries.set(identity, budget);
    return budget;
  }
}
export function scriptedKernel(replies) {
  let cursor = 0;
  return async (request, signal) => {
    signal?.throwIfAborted();
    if (cursor >= replies.length) throw Error("kernel script exhausted");
    return structuredClone(replies[cursor++]);
  };
}
