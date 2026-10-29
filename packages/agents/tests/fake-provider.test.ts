// The fake keeps the contract the real adapters keep, so the package's tests
// on it hold for them too.
import { ANSWER, providerContract } from "./contract.ts";
import { fakeProvider } from "./fake-provider.ts";

providerContract("The fake provider", {
  setUp: (script) =>
    Promise.resolve({
      adapter: fakeProvider({ script, answer: ANSWER }).adapter,
      options: {
        cwd: "/fictional/ai",
        model: "fake-model",
        effort: "medium",
        tools: { url: "http://127.0.0.1:9/mcp", key: "fictional-key" },
      },
    }),
  callMeta: (_conversation, turn, call) =>
    Promise.resolve({ "fake/turn": turn, "fake/call": call }),
});
