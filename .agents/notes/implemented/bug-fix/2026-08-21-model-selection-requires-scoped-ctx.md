# Agent Note: installModelSelection refuses an untagged context

Status: implemented

English | [中文](2026-08-21-model-selection-requires-scoped-ctx.zh.md)

## Problem

`installModelSelection` accepted any Context. A listener registered on an untagged context is admitted to every dispatch in the process (the scope filter returns true for `tag === undefined`), and waterfall order makes the earliest registration's override final — so one Agent's selection would rewrite every other Agent's prompt assembly and request routing. Both in-repo entry points (`dsh-host-apiproxy`, `dsh-bundle-headless`) pass the Agent's scoped context, but nothing enforced that, and the package's own spec installed the pair on a bare root Context — demonstrating the unsafe shape as the example.

## Decision

`installModelSelection` throws when `scopeOf(agentCtx)` is undefined, stating why in the message. A tagged context that is not the Agent's own scope stays allowed deliberately: admission is then an explicit scope-chain choice, not a silent process-global one.

## Alternatives considered

- **Check `agentCtx.agent` instead of the scope tag.** An untagged context can carry the accessor through a plain `extend`; the accessor does not prove admission scope.
- **Warn and install anyway.** The misuse is silent cross-session routing corruption; a warning leaves the failure in place.

## Consequences

Misuse now fails at install time instead of becoming a process-global listener. Six test harnesses that had been constructing stub agents on untagged contexts — `dsh-host-apiproxy`'s models, agent-preset, cold, and fork specs and `dsh-bundle-headless`'s runner spec, plus the package spec itself — now build real scope keys; they had been exercising the listeners through global admission without saying so. `dsh-bundle-headless` gained `dsh-scope` as a test-only devDependency.

## Testing

The package spec covers the refusal and re-pins the snapshot/dispose behavior on a real scope key; the six reworked harnesses and the rest of the affected packages run green under the guard.
