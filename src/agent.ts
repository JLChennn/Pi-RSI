import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { WorkspaceService } from '../benchmarks/fault-injector.js';
import { createRecoveryTool } from './harness/recovery-tool.js';
import { TrajectoryCollector } from './trajectory.js';

export type ModelConfig = { provider: string; model: string; apiKey: string;
  api?: 'openai-responses' | 'openai-completions' | 'anthropic-messages'; baseUrl?: string;
  timeoutMs: number; maxTurns: number };
export function readModelConfig(loadFile = true): ModelConfig {
  if (loadFile && existsSync('.env')) loadEnvFile('.env');
  const value = (name: string) => process.env[name]?.trim() || undefined;
  const baseUrl = value('PI_RSI_BASE_URL') ?? value('OPENAI_BASE_URL');
  const provider = value('PI_RSI_PROVIDER') ?? (baseUrl ? 'iquest' : undefined);
  const model = value('PI_RSI_MODEL') ?? value('MODEL_NAME');
  const apiKey = value('PI_RSI_API_KEY') ?? value('OPENAI_API_KEY');
  const missing = [!provider && 'PI_RSI_PROVIDER', !model && 'PI_RSI_MODEL / MODEL_NAME',
    !apiKey && 'PI_RSI_API_KEY / OPENAI_API_KEY'].filter(Boolean);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}. Copy .env.example to .env and configure your own model; no simulated LLM fallback.`);
  const mode = value('OPENAI_API_MODE');
  const explicitApi = value('PI_RSI_API');
  if (!explicitApi && mode && !['responses', 'completions'].includes(mode))
    throw new Error('Unsupported PI_RSI_API / OPENAI_API_MODE. Use responses or completions.');
  const api = explicitApi ?? (mode === 'responses' ? 'openai-responses' : mode === 'completions' ? 'openai-completions' : undefined);
  if (Boolean(api) !== Boolean(baseUrl)) throw new Error('Set PI_RSI_API and PI_RSI_BASE_URL together.');
  if (api && !['openai-responses', 'openai-completions', 'anthropic-messages'].includes(api))
    throw new Error('Unsupported PI_RSI_API. See .env.example.');
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol))
      throw new Error('BASE_URL must be an HTTP(S) endpoint without credentials, query or fragment.');
  }
  const timeoutMs = Number(process.env.PI_RSI_TIMEOUT_MS ?? 60000);
  const maxTurns = Number(process.env.PI_RSI_MAX_TURNS ?? 8);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000 ||
      !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 30)
    throw new Error('Timeout must be 100..300000 ms and max turns 1..30.');
  return { provider: provider!, model: model!, apiKey: apiKey!,
    api: api as ModelConfig['api'], baseUrl, timeoutMs, maxTurns };
}

/** Real SDK construction, independent of network inference. No user-global auth/config files. */
export async function createWorker(config: ModelConfig, service: WorkspaceService, taskId: string, tracePath: string) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  if (config.api && config.baseUrl) runtime.registerProvider(config.provider, {
    api: config.api, baseUrl: config.baseUrl,
    // Placeholder auth reference; the effective key is supplied by the runtime overlay below.
    apiKey: 'PI_RSI_API_KEY',
    models: [{ id: config.model, name: config.model, input: ['text'], reasoning: false,
      contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  await runtime.setRuntimeApiKey(config.provider, config.apiKey);
  const model = runtime.getModel(config.provider, config.model);
  if (!model) throw new Error('Configured model is absent from the pinned Pi catalog. Configure API + BASE_URL for a custom model.');
  const manager = SessionManager.inMemory(process.cwd());
  const trace = new TrajectoryCollector(tracePath, manager.getSessionId(), taskId, [config.apiKey]);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false,
    provider: { maxRetries: 0 } }, cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false });
  const agentDir = join(process.cwd(), '.pi-rsi');
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir, settingsManager: settings,
    noExtensions: true, disabledBuiltinExtensions: ['mcp', 'codemode'], noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Use only workspace_service for the controlled task. Report only JSON as specified by the user. A tool error is not proof that a write did not commit. Never invent a successful tool result.' });
  try {
    await loader.reload();
    const { session, extensionsResult } = await createAgentSession({ cwd: process.cwd(), agentDir,
      modelRuntime: runtime, model, thinkingLevel: 'off', resourceLoader: loader,
      settingsManager: settings, sessionManager: manager, tools: ['workspace_service'],
      customTools: [createRecoveryTool(service, trace)] });
    const active = session.getActiveToolNames();
    if (active.length !== 1 || active[0] !== 'workspace_service' || extensionsResult.errors.length)
      { session.dispose(); throw new Error('Unexpected Worker tool loadout or extension loading error.'); }
    let turns = 0;
    let budgetExceeded = false;
    const unsubscribe = session.subscribe(event => {
      // Session events contain messages/tool results, not HTTP payload/header hooks.
      const { type, ...payload } = event;
      trace.record(`pi_${type}`, payload);
      if (type === 'tool_execution_start') trace.record('llm_tool_call', payload);
      if (type === 'turn_end') {
        turns++;
        // A final answer on the last permitted turn is still a normal completion.
        if (turns >= config.maxTurns && event.message.role === 'assistant' &&
            event.message.content.some(block => block.type === 'toolCall')) {
          budgetExceeded = true;
          void session.abort();
        }
      }
    });
    trace.record('worker_created', { provider: config.provider, model: config.model, policy: 'H0',
      activeTools: active, maxTurns: config.maxTurns, timeoutMs: config.timeoutMs });
    return { session, trace, budgetExceeded: () => budgetExceeded, close: () => { unsubscribe(); session.dispose(); } };
  } catch (error) {
    trace.record('worker_setup_error', { success: false, error: 'Pi SDK setup failed' });
    throw error;
  }
}

export type WorkerResult = { finalText: string; stopReason: string; runError?: string };
export async function runWorker(config: ModelConfig, service: WorkspaceService, taskId: string,
  prompt: string, tracePath: string): Promise<{ result: WorkerResult; trace: TrajectoryCollector }> {
  const worker = await createWorker(config, service, taskId, tracePath);
  worker.trace.record('task_start', { prompt, scenario: service.scenario });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void worker.session.abort(); }, config.timeoutMs);
  let result: WorkerResult;
  try {
    await worker.session.prompt(prompt);
    result = finalResult(worker.session);
    if (timedOut || worker.budgetExceeded()) result = { ...result,
      runError: timedOut ? 'ETIMEOUT' : 'ETURNLIMIT', stopReason: 'aborted' };
    if (['error', 'aborted', 'length', 'missing'].includes(result.stopReason))
      result.runError ??= `EPROVIDER_${result.stopReason.toUpperCase()}`;
  } catch {
    // Do not print opaque provider exceptions, which can contain request credentials.
    result = { finalText: '', stopReason: 'error', runError: timedOut ? 'ETIMEOUT' : 'EWORKER' };
  } finally { clearTimeout(timer); worker.close(); }
  worker.trace.record('task_end', { ...result, success: !result.runError, serviceCalls: service.calls,
    records: service.records, successfulReads: service.successfulReads });
  return { result, trace: worker.trace };
}
function finalResult(session: AgentSession): WorkerResult {
  const last = [...session.state.messages].reverse().find(message => message.role === 'assistant');
  if (!last || last.role !== 'assistant') return { finalText: '', stopReason: 'missing' };
  return { finalText: last.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    stopReason: last.stopReason };
}
