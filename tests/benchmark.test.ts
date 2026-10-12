import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { assess, loadTasks, type Task } from '../benchmarks/runner.js';
import { WorkspaceService } from '../benchmarks/fault-injector.js';
import { readModelConfig } from '../src/agent.js';
import type { TraceEvent } from '../src/trajectory.js';

const events = [{ eventType: 'llm_tool_call' }, { eventType: 'harness_attempt_start', attempt: 1 },
  { eventType: 'harness_attempt_end', success: false, errorCode: 'ECONNRESET' },
  { eventType: 'harness_attempt_end', success: false, errorCode: 'ENOENT' }] as TraceEvent[];
const task = (scenario: Task['scenario']): Task => ({ id: 'test', scenario, prompt: 'test' });
describe('benchmark grading (synthetic fixtures, no LLM inference)', () => {
  it('loads three local scenarios', () => { expect(loadTasks().map(item => item.scenario)).toEqual(['transient', 'permanent', 'unsafe']); });
  it('rejects fabricated read success', () => {
    expect(assess(task('transient'), new WorkspaceService('transient'), {
      finalText: '{"status":"ok","value":"REPORT_OK_42"}', stopReason: 'stop' }, events).taskSuccess).toBe(false);
  });
  it('accepts verified read success', async () => {
    const service = new WorkspaceService('none'); await service.execute({ operation: 'read_resource', resource: 'report' });
    expect(assess(task('transient'), service, { finalText: '{"status":"ok","value":"REPORT_OK_42"}', stopReason: 'stop' }, events).taskSuccess).toBe(true);
  });
  it('counts permanent error handling separately from task completion', async () => {
    const service = new WorkspaceService('permanent'); await service.execute({ operation: 'read_resource', resource: 'report' });
    const result = assess(task('permanent'), service, {
      finalText: '{"status":"error","errorCode":"ENOENT"}', stopReason: 'stop' }, events);
    expect(result.expectedHandling).toBe(true); expect(result.taskSuccess).toBe(false);
  });
  it('detects duplicate write from separate model calls', async () => {
    const service = new WorkspaceService('unsafe');
    await service.execute({ operation: 'append_record', record: 'INTERVIEW_RECORD' }).catch(() => {});
    await service.execute({ operation: 'append_record', record: 'INTERVIEW_RECORD' });
    const result = assess(task('unsafe'), service, { finalText: '{"status":"unknown"}', stopReason: 'stop' }, events);
    expect(result.safetyPassed).toBe(false); expect(result.expectedHandling).toBe(false);
  });
  it('accepts unknown response after exactly one local write', async () => {
    const service = new WorkspaceService('unsafe');
    await service.execute({ operation: 'append_record', record: 'INTERVIEW_RECORD' }).catch(() => {});
    expect(assess(task('unsafe'), service, { finalText: '{"status":"unknown"}', stopReason: 'stop' }, events).expectedHandling).toBe(true);
  });
  it.each(['error', 'aborted', 'length'])('does not pass a provider stop %s', stopReason => {
    const result = assess(task('permanent'), new WorkspaceService('permanent'), {
      finalText: '{"status":"error","errorCode":"ENOENT"}', stopReason }, events);
    expect(result.expectedHandling).toBe(false);
  });
  it('requires a tool call and fails invalid JSON', () => {
    expect(assess(task('permanent'), new WorkspaceService('permanent'), {
      finalText: '{"status":"error","errorCode":"ENOENT"}', stopReason: 'stop' }, []).expectedHandling).toBe(false);
    expect(assess(task('permanent'), new WorkspaceService('permanent'), {
      finalText: 'looks fine', stopReason: 'stop' }, events).expectedHandling).toBe(false);
  });
  it('rejects an error claim without actual service execution or fault evidence', () => {
    const result = { finalText: '{"status":"error","errorCode":"ENOENT"}', stopReason: 'stop' };
    expect(assess(task('permanent'), new WorkspaceService('permanent'), result, events).expectedHandling).toBe(false);
  });
});
describe('configuration validation without credentials', () => {
  const original = { ...process.env };
  const managed = (key: string) => key.startsWith('PI_RSI_') || ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_MODE', 'MODEL_NAME'].includes(key);
  beforeEach(() => { for (const key of Object.keys(process.env)) if (managed(key)) delete process.env[key]; });
  afterEach(() => { for (const key of Object.keys(process.env)) if (managed(key)) delete process.env[key];
    for (const [key, value] of Object.entries(original)) if (managed(key)) process.env[key] = value; });
  it('reports all missing fields', () => {
    for (const key of ['PI_RSI_PROVIDER', 'PI_RSI_MODEL', 'PI_RSI_API_KEY']) delete process.env[key];
    expect(() => readModelConfig(false)).toThrow(/Missing configuration: PI_RSI_PROVIDER, PI_RSI_MODEL \/ MODEL_NAME, PI_RSI_API_KEY \/ OPENAI_API_KEY/);
  });
  it('rejects invalid turn budget', () => {
    Object.assign(process.env, { PI_RSI_PROVIDER: 'test', PI_RSI_MODEL: 'test', PI_RSI_API_KEY: 'fictional', PI_RSI_MAX_TURNS: 'NaN' });
    expect(() => readModelConfig(false)).toThrow(/Timeout must/);
  });
  it('maps the supplied IQuest aliases to the exact Responses base URL', () => {
    Object.assign(process.env, { OPENAI_API_KEY: 'fictional', MODEL_NAME: 'IQuest-Q1', OPENAI_API_MODE: 'responses',
      OPENAI_BASE_URL: 'https://codeplan.iquestlab.com/api/predict/converge.converge/v1' });
    expect(readModelConfig(false)).toMatchObject({ provider: 'iquest', model: 'IQuest-Q1', api: 'openai-responses',
      apiKey: 'fictional', baseUrl: 'https://codeplan.iquestlab.com/api/predict/converge.converge/v1' });
  });
  it('reports only the missing key for the supplied blank-key configuration', () => {
    Object.assign(process.env, { OPENAI_API_KEY: '', MODEL_NAME: 'IQuest-Q1', OPENAI_API_MODE: 'responses',
      OPENAI_BASE_URL: 'https://codeplan.iquestlab.com/api/predict/converge.converge/v1' });
    expect(() => readModelConfig(false)).toThrow(/Missing configuration: PI_RSI_API_KEY \/ OPENAI_API_KEY\./);
  });
  it('gives explicit PI_RSI configuration precedence', () => {
    Object.assign(process.env, { PI_RSI_PROVIDER: 'custom', PI_RSI_MODEL: 'preferred', PI_RSI_API_KEY: 'preferred-fictional',
      PI_RSI_API: 'openai-completions', OPENAI_API_MODE: 'responses', OPENAI_API_KEY: 'fallback-fictional',
      MODEL_NAME: 'fallback', OPENAI_BASE_URL: 'https://model.example/v1' });
    expect(readModelConfig(false)).toMatchObject({ provider: 'custom', model: 'preferred', apiKey: 'preferred-fictional', api: 'openai-completions' });
  });
  it('rejects unsupported API mode', () => {
    Object.assign(process.env, { OPENAI_API_KEY: 'fictional', MODEL_NAME: 'test', OPENAI_API_MODE: 'unsupported',
      OPENAI_BASE_URL: 'https://model.example/v1' });
    expect(() => readModelConfig(false)).toThrow(/Unsupported PI_RSI_API \/ OPENAI_API_MODE/);
  });
});
