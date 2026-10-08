import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Usage } from "../types";
import { ZERO_USAGE } from "../usage";
import { costAtListPrice, priceOf } from "./prices";

// Small helpers shared by every call that goes through the Agent SDK.

/**
 * The environment for the SDK's child process.
 * Passing `env` replaces the child's environment, so process.env is spread in to keep PATH and the credential.
 * Auto memory is switched off so nothing from this machine's Claude Code setup leaks into a run.
 */
export function sdkEnv(): Record<string, string | undefined> {
  return { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
}

/**
 * Reads tokens and cost from the result message, which is present on success and on error.
 * `modelUsage` has one entry per model, because the SDK also makes one small call on a second model.
 * Tokens are summed over the entries. Each entry is priced at its own model's list price.
 * The cost is an estimate at list prices, not a charge.
 */
export function usageFromResult(result: SDKResultMessage): Usage {
  const usage: Usage = { ...ZERO_USAGE };
  for (const [model, counts] of Object.entries(result.modelUsage)) {
    const tokens = {
      inputTokens: counts.inputTokens,
      outputTokens: counts.outputTokens,
      cacheReadTokens: counts.cacheReadInputTokens,
      cacheCreationTokens: counts.cacheCreationInputTokens,
    };
    usage.inputTokens += tokens.inputTokens;
    usage.outputTokens += tokens.outputTokens;
    usage.cacheReadTokens += tokens.cacheReadTokens;
    usage.cacheCreationTokens += tokens.cacheCreationTokens;

    const price = priceOf(model);
    if (price) {
      usage.costUsd += costAtListPrice(tokens, price);
    } else {
      // Every model the eval uses is in the table, and a test checks that. This only happens
      // when `ask` is run with some other model. The SDK's own figure is then the best there is.
      warnNoPrice(model);
      usage.costUsd += counts.costUSD;
    }
  }
  return usage;
}

const modelsWithoutPrice = new Set<string>();

/** Says once per model that its cost is the SDK's estimate and not from the price table. */
function warnNoPrice(model: string): void {
  if (modelsWithoutPrice.has(model)) return;
  modelsWithoutPrice.add(model);
  console.error(
    `[agent sdk] no list price for ${model} in src/llm/prices.ts. Its cost is the SDK's own estimate.`,
  );
}

/** Why a run ended badly, as one line. */
export function errorFromResult(result: SDKResultMessage): string | undefined {
  if (result.subtype === "success") return undefined;
  return `${result.subtype}: ${result.errors.join(" ")}`.trim();
}

// ---------- Credential and plan limits ----------

export type PlanUsage = {
  status: string;
  /** Share of the five hour window used, 0 to 1. Null on an API key. */
  fiveHour: number | null;
  /** Share of the seven day window used, 0 to 1. Null on an API key. */
  sevenDay: number | null;
};

let credentialReported = false;
let planUsage: PlanUsage | null = null;

/** The latest plan usage the SDK reported. Long eval runs print it so a limit does not come as a surprise. */
export function latestPlanUsage(): PlanUsage | null {
  return planUsage;
}

/**
 * Call this with every message of every run.
 * It says once which credential is in use, because an API key silently outranks a subscription token,
 * and it remembers the latest rate limit report.
 */
export function observeSdkMessage(message: SDKMessage): void {
  if (message.type === "system" && message.subtype === "init" && !credentialReported) {
    credentialReported = true;
    const source = message.apiKeySource === "none" ? "subscription token" : message.apiKeySource;
    console.error(`[agent sdk] credential in use: ${source}`);
  }
  if (message.type === "rate_limit_event") {
    const info = message.rate_limit_info as {
      status?: string;
      unifiedWindows?: Record<string, { utilization?: number } | undefined>;
    };
    planUsage = {
      status: info.status ?? "unknown",
      fiveHour: info.unifiedWindows?.five_hour?.utilization ?? null,
      sevenDay: info.unifiedWindows?.seven_day?.utilization ?? null,
    };
  }
}
