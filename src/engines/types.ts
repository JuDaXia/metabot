import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type {
  ClaudeExecutor,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
  ApiContext,
  TeamEvent,
} from './claude/executor.js';
import type { CodexExecutor } from './codex/executor.js';
import type { StreamProcessor } from './claude/stream-processor.js';

export type EngineName = 'claude' | 'kimi' | 'codex';

/**
 * Reasoning-effort level for Claude, passed straight through to the Agent SDK
 * `query({ options: { effort } })`. Controls how much thinking Claude spends:
 * `low` fastest/cheapest … `max` deepest. Higher levels (`xhigh`/`max`) are
 * model-gated; the SDK silently downgrades unsupported levels for the active
 * model. `undefined` = don't set it (use the model's own default). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Validate/normalise an arbitrary string into an EffortLevel, or undefined. */
export function parseEffort(value: string | undefined | null): EffortLevel | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as EffortLevel) : undefined;
}

export { EFFORT_LEVELS };

/**
 * An Engine is a programmable agent backend (Claude Code, Kimi Code, …).
 * It produces an Executor that the bridge drives for a single chat session.
 *
 * In Phase 1 we only ship the Claude implementation; the interface lets us
 * drop in a Kimi implementation without touching the bridge.
 */
export interface Engine {
  readonly name: EngineName;
  /** Returns the executor used to run queries for this engine. */
  createExecutor(): Executor;
  /** Returns the StreamProcessor class used to process engine messages into CardState. */
  createStreamProcessor(userPrompt: string): StreamProcessorLike;
}

/**
 * Executor abstraction. Both engines must support the multi-turn
 * `startExecution` path (streaming + sendAnswer + resolveQuestion + finish)
 * and the one-shot `execute` path used by voice mode.
 *
 * Phase 1 aliases these to the Claude types. Phase 2 will generalise
 * SDKMessage into a union (EngineMessage) with Kimi-specific events.
 */
export interface Executor {
  startExecution(options: ExecutorOptions): ExecutionHandle;
  execute(options: ExecutorOptions): AsyncGenerator<SDKMessage>;
}

export type StreamProcessorLike = StreamProcessor;

export type {
  ClaudeExecutor,
  CodexExecutor,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
  ApiContext,
  TeamEvent,
};

/** Context passed to engine factory. */
export interface EngineContext {
  config: BotConfigBase;
  logger: Logger;
}
