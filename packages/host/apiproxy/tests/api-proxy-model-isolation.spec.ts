/**
 * Cross-session model-selection isolation: one session's switch must never
 * reach another session's requests, while a blank new session legitimately
 * follows the saved process default. Runs the real AgentLoop factory, real
 * scope keys, and the real RPC surface, so listener admission follows
 * production routing instead of a stub context.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it } from 'vitest'
import type { RpcRequest } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 0
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`isolation-${String(nextRpc++)}`), payload }
}

const PROVIDER = 'tokensforce'

/** One adapter serving every model the scenario switches between. */
class RecordingAdapter extends LlmAdapter {
  /** Outgoing conversation requests in call order: provider/model/system triples. */
  readonly requests: { provider: string; model: string; system: string }[] = []

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider: PROVIDER, id: 'baize', name: 'Baize' },
      { provider: PROVIDER, id: 'glm-5.1', name: 'GLM 5.1' },
      { provider: PROVIDER, id: 'glm-5.3', name: 'GLM 5.3' },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({
      provider: options.provider,
      model: options.model,
      system: options.system ?? '',
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function harness(options: { cwd?: string; persistenceRoot?: string } = {}): Promise<{
  api: ReturnType<typeof createApiProxy>
  ctx: Context
  adapter: RecordingAdapter
  defaults: { current: { provider: string; model: string } }
}> {
  return (async () => {
    const cwd = options.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), 'dsh-model-isolation-')))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { persona: 'You are running on the {{model}} model.' },
    })
    if (options.persistenceRoot !== undefined) {
      await ctx.plugin(JsonlSessionPersistence, { root: options.persistenceRoot, compression: 'none' })
    }
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter([PROVIDER], adapter)
    const defaults = { current: { provider: PROVIDER, model: 'glm-5.3' } }
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ ...defaults.current }),
      saveDefaultModelSelection: (selection) => {
        defaults.current = { ...selection }
        return Promise.resolve()
      },
      cwd,
    })
    return { api, ctx, adapter, defaults }
  })()
}

function expectOk<T>(response: { result: { ok: true; value: T } | { ok: false } }): T {
  if (!response.result.ok) throw new Error(`expected successful response: ${JSON.stringify(response.result)}`)
  return response.result.value
}

function idle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

/** Resolve once the session logs a request/header, regardless of turn timing. */
function headerLogged(ctx: Context, sessionId: SessionId): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId || event.type !== 'request/header') return
      dispose()
      resolve()
    })
  })
}

async function promptToIdle(
  api: ReturnType<typeof createApiProxy>,
  ctx: Context,
  sessionId: string,
): Promise<void> {
  const agent = ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`agent for "${sessionId}" is not live`)
  const settled = idle(ctx, agent)
  expectOk(await api.sessions.prompt(request({
    sessionId: SessionId(sessionId),
    mode: 'queue' as const,
    content: [{ type: 'text' as const, text: 'hi' }],
  })))
  await settled
}

describe('cross-session model selection isolation', () => {
  it('keeps another session\'s switch out of this session\'s request and persona', async () => {
    const { api, ctx, adapter } = await harness()

    expectOk(await api.sessions.create(request({ sessionId: SessionId('sess-a') })))
    expectOk(await api.sessions.selectModel(request({
      sessionId: SessionId('sess-a'), provider: PROVIDER, model: 'baize',
    })))
    await promptToIdle(api, ctx, 'sess-a')

    expectOk(await api.sessions.create(request({ sessionId: SessionId('sess-b') })))
    expectOk(await api.sessions.selectModel(request({
      sessionId: SessionId('sess-b'), provider: PROVIDER, model: 'glm-5.1',
    })))
    await promptToIdle(api, ctx, 'sess-b')

    const headerA = ctx.sessions.get(SessionId('sess-a'))?.requestHeader()
    const headerB = ctx.sessions.get(SessionId('sess-b'))?.requestHeader()
    expect(headerA?.config.model).toBe('baize')
    expect(headerA?.system).toContain('baize')
    expect(headerB?.config.model).toBe('glm-5.1')
    expect(headerB?.system).toContain('glm-5.1')
    expect(adapter.requests.map(request_ => request_.model)).toEqual(['baize', 'glm-5.1'])
    await ctx.fiber.dispose()
  })

  it('starts a blank new session on the saved default without inheriting a foreign log', async () => {
    const { api, ctx, adapter, defaults } = await harness()

    expectOk(await api.sessions.create(request({ sessionId: SessionId('sess-first') })))
    expectOk(await api.sessions.selectModel(request({
      sessionId: SessionId('sess-first'), provider: PROVIDER, model: 'baize',
    })))
    await promptToIdle(api, ctx, 'sess-first')

    // The documented sticky default: the switch persists as the process
    // default, and a session whose log names no request reads it live.
    expect(defaults.current).toEqual({ provider: PROVIDER, model: 'baize' })
    expectOk(await api.sessions.create(request({ sessionId: SessionId('sess-blank') })))
    await promptToIdle(api, ctx, 'sess-blank')
    const header = ctx.sessions.get(SessionId('sess-blank'))?.requestHeader()
    expect(header?.config.model).toBe('baize')
    expect(header?.system).toContain('baize')
    expect(adapter.requests.map(request_ => request_.model)).toEqual(['baize', 'baize'])
    await ctx.fiber.dispose()
  })

  it('keeps a switch accepted during a concurrent reconnect create on the driving agent', async () => {
    // A reconnect fires session.create (ensureSession resume) and an asserted
    // model switch (agentFor resume) at one just-restarted persisted session;
    // the two dedup maps are distinct, so the switch must still land on the
    // instance that ends up driving turns.
    const root = mkdtempSync(join(tmpdir(), 'dsh-model-isolation-root-'))
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-model-isolation-cwd-')))
    const first = await harness({ persistenceRoot: root, cwd })
    expectOk(await first.api.sessions.create(request({ sessionId: SessionId('sess-restart') })))
    await promptToIdle(first.api, first.ctx, 'sess-restart')
    await first.ctx.fiber.dispose()

    const second = await harness({ persistenceRoot: root, cwd })
    const [created, selected] = await Promise.all([
      second.api.sessions.create(request({ sessionId: SessionId('sess-restart') })),
      second.api.sessions.selectModel(request({
        sessionId: SessionId('sess-restart'), provider: PROVIDER, model: 'glm-5.1',
      })),
    ])
    expectOk(created)
    expectOk(selected)
    await promptToIdle(second.api, second.ctx, 'sess-restart')
    const header = second.ctx.sessions.get(SessionId('sess-restart'))?.requestHeader()
    expect(header?.config.model).toBe('glm-5.1')
    expect(header?.system).toContain('glm-5.1')
    expect(second.adapter.requests.map(request_ => request_.model)).toEqual(['glm-5.1'])
    await second.ctx.fiber.dispose()
  })

  it('applies a switch racing the first prompt after a restart', async () => {
    // No create call: both the switch and the prompt cold-resume through the
    // shared agentFor dedup, so the switch must precede the turn's assembly.
    const root = mkdtempSync(join(tmpdir(), 'dsh-model-isolation-root-'))
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-model-isolation-cwd-')))
    const first = await harness({ persistenceRoot: root, cwd })
    expectOk(await first.api.sessions.create(request({ sessionId: SessionId('sess-racing') })))
    await promptToIdle(first.api, first.ctx, 'sess-racing')
    await first.ctx.fiber.dispose()

    const second = await harness({ persistenceRoot: root, cwd })
    const resumed = headerLogged(second.ctx, SessionId('sess-racing'))
    const [selected, prompt] = await Promise.all([
      second.api.sessions.selectModel(request({
        sessionId: SessionId('sess-racing'), provider: PROVIDER, model: 'glm-5.1',
      })),
      second.api.sessions.prompt(request({
        sessionId: SessionId('sess-racing'),
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: 'hi again' }],
      })),
    ])
    expectOk(selected)
    expectOk(prompt)
    await resumed
    const header = second.ctx.sessions.get(SessionId('sess-racing'))?.requestHeader()
    expect(header?.config.model).toBe('glm-5.1')
    expect(header?.system).toContain('glm-5.1')
    await second.ctx.fiber.dispose()
  })

  it('answers a blank session\'s first turn on the model its accepted switch named, not the process default another session left', async () => {
    // The pollution composition: session A's switch persists as the process
    // default (documented sticky default); blank session B has no logged
    // header, so its selection falls through to that default. If B's own
    // accepted switch races B's first prompt, the turn's assembly can read
    // the default BEFORE the switch's write lands — and the first request
    // goes out on A's model despite B's switch having been accepted first.
    const { api, ctx, adapter } = await harness()

    expectOk(await api.sessions.create(request({ sessionId: SessionId('sess-poller') })))
    expectOk(await api.sessions.selectModel(request({
      sessionId: SessionId('sess-poller'), provider: PROVIDER, model: 'baize',
    })))
    expectOk(await api.sessions.create(request({ sessionId: SessionId('sess-victim') })))
    const victim = ctx.agents.get(SessionId('sess-victim'))
    if (victim === undefined) throw new Error('victim agent is not live after create')

    const logged = headerLogged(ctx, SessionId('sess-victim'))
    const settled = idle(ctx, victim)
    const [selected, prompt] = await Promise.all([
      api.sessions.selectModel(request({
        sessionId: SessionId('sess-victim'), provider: PROVIDER, model: 'glm-5.1',
      })),
      api.sessions.prompt(request({
        sessionId: SessionId('sess-victim'),
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: 'hi' }],
      })),
    ])
    expectOk(selected)
    expectOk(prompt)
    await logged
    await settled
    const header = ctx.sessions.get(SessionId('sess-victim'))?.requestHeader()
    expect(header?.config.model).toBe('glm-5.1')
    expect(header?.system).toContain('glm-5.1')
    expect(adapter.requests.at(-1)?.model).toBe('glm-5.1')
    await ctx.fiber.dispose()
  })
})
