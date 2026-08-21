import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  agentEvents,
  assembleContextFor,
  installModelSelection,
  type Agent,
  type ModelSelectionRef,
} from '../src/index.ts'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'

describe('installModelSelection()', () => {
  it('snapshots prompt variables and request routing together, then disposes both listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const agent = {} as Agent
    // The Agent object is its own scope key in production; the listener pair
    // must be registered on that tagged context to stay off other dispatches.
    const scope = createScope(ctx, agent)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const dispose = installModelSelection(scope.ctx, selection)
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    selection.current = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).variables)
      .toMatchObject({ provider: 'alpha', model: 'a1' })
    selection.current = { provider: 'beta', model: 'b1' }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.2,
    })

    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).variables)
      .toMatchObject({ provider: 'beta', model: 'b1' })
    const inherited: LlmCallConfig = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('max'),
      temperature: 0.2,
    }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({
      provider: 'beta',
      model: 'b1',
      temperature: 0.2,
    })

    dispose()
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })

  it('refuses an untagged context instead of installing process-global listeners', async () => {
    const ctx = new Context()
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    expect(() => installModelSelection(ctx, selection)).toThrow(
      'model-selection: installModelSelection needs the Agent\'s scoped context; an untagged context admits both listeners to every dispatch in the process',
    )
    await ctx.fiber.dispose()
  })
})
