import { describe, expect, it } from "vitest";

import { buildOnboardingLLMTestConfig } from "../../../renderer/hooks/useOnboardingFlow";
import { LLMSettingsSchema } from "../../utils/validation";

describe("buildOnboardingLLMTestConfig", () => {
  it("includes the selected OpenRouter model required by the LLM IPC schema", () => {
    const config = buildOnboardingLLMTestConfig(
      "openrouter",
      "sk-or-test-key",
      "http://localhost:11434",
    );

    expect(config).toMatchObject({
      providerType: "openrouter",
      modelKey: "openrouter/free",
      openrouter: {
        apiKey: "sk-or-test-key",
        model: "openrouter/free",
      },
    });
    expect(LLMSettingsSchema.safeParse(config).success).toBe(true);
  });

  it("builds correct config for minimax with default model and customProviders", () => {
    const config = buildOnboardingLLMTestConfig(
      "minimax",
      "minimax-test-key",
      "http://localhost:11434",
    );

    expect(config).toMatchObject({
      providerType: "minimax",
      modelKey: "MiniMax-M2.1",
      customProviders: {
        minimax: {
          apiKey: "minimax-test-key",
          baseUrl: "https://api.minimax.io/v1",
          model: "MiniMax-M2.1",
        },
      },
    });
    expect(LLMSettingsSchema.safeParse(config).success).toBe(true);
  });
});
