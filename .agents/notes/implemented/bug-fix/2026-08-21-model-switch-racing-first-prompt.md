# Agent Note: An accepted model switch reaches the turn of a prompt issued after it

Status: implemented

English | [中文](2026-08-21-model-switch-racing-first-prompt.zh.md)

## Problem

`sessions.selectModel` validates the requested route with an awaited `resolveCallConfig` before it writes the per-session picked selection, while `sessions.prompt` dispatched its turn with no ordering against that write. A prompt issued after a switch could therefore start its turn, assemble, and read the selection fallback tier before the switch's write landed. Which tier the turn then took depended on the session's own history: a session with a logged `request/header` fell back to its own last model, so an accepted switch silently skipped that turn, and a blank session fell back to the live process default — which every switch in any session persists — so the blank session's first turn went to a model that session never chose while its own switch had already been accepted.

The per-agent chain that admits image checks against model selection existed for exactly this ordering, but `sessions.prompt` entered it only for image content; text prompts dispatched unserialized. The defect needed a switch and a prompt in flight for one agent at the same time, which is why sequential switch-then-prompt clients never saw it.

## Decision

Every `sessions.prompt` admission — text or image — goes through the per-agent chain, now named `serializeSelectionAdmission`: model switches, image-capability checks, and turn dispatch order per agent. RPC issue order decides: a switch accepted before a prompt's dispatch lands before that turn's assembly reads the selection, and a switch arriving after dispatch keeps the documented next-assembly semantics. The assembly snapshot contract in `dsh-agent`'s model-selection listeners is unchanged, and the sticky default itself stays as designed — a blank session that never switched still reads the saved default.

Entry order into the chain is deterministic rather than timing luck: both RPCs resolve their agent through the same `agentFor` promise chain, and continuation order fixes chain order.

## Alternatives considered

- **Write the picked selection before validating, roll back on refusal.** A transiently unvalidated selection becomes visible to a racing assembly and can route a turn that `prepareCall` then rejects; acceptance must precede visibility.
- **Await pending switches inside the assembly listener.** `ModelSelectionRef.current` is a synchronous interface, and making it async reshapes the `dsh-agent` seam for what is a gateway-side ordering concern.
- **Serialize inside `turnAgentFor`.** The dispatch (`followup`/`steer`) happens in the handler after `turnAgentFor` returns, so the handler's admission body is the serialization unit.
- **Pull the inbox queue-item steer into the chain.** It injects into a turn that is already running and cannot start a new assembly, so ordering it buys nothing.

## Consequences

A client that fires a switch and a prompt concurrently now gets first-RPC-wins ordering instead of an interleaving-dependent model, and a blank session's first turn names the model its accepted switch selected rather than the most recent switch anywhere in the process. Sequential flows are unchanged. `turnAgentFor`'s route-served refusal check still reads the selection before chain entry, so a saved default naming an unroutable route plus a racing switch to a routable one can still refuse a prompt on the stale read — same family, named here, not fixed by this change.

## Testing

`packages/host/apiproxy/tests/api-proxy-model-isolation.spec.ts` runs the real AgentLoop factory, real scope keys, the real RPC surface, and real JSONL persistence for the restart scenarios. It pins natural cross-session isolation, a blank session following the saved default, a reconnect race between `session.create` and a switch converging on the driving agent, a switch racing the first prompt after a restart, and the pollution composition: a foreign sticky default, an accepted switch, and a racing first prompt answering on the switched model. The two race tests fail on the pre-fix tree and pass after it; stress runs stay green because the ordering rests on microtask FIFO, not scheduling luck.
