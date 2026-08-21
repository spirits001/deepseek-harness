# Agent Note: installModelSelection 拒绝无作用域标签的上下文

Status: implemented

[English](2026-08-21-model-selection-requires-scoped-ctx.md) | 中文

## Problem

`installModelSelection` 曾接受任意 Context。注册在无标签上下文上的监听器会被进程内的每一次分发命中（scope filter 对 `tag === undefined` 恒返回 true），而 waterfall 的顺序语义让最早注册者的覆盖最终生效——一个 Agent 的选择会改写其他所有 Agent 的提示词组装与请求路由。库内的两个入口（`dsh-host-apiproxy`、`dsh-bundle-headless`）传的都是 Agent 的 scoped context，但没有任何机制强制这一点，且包自带的 spec 恰恰把这对监听器装在裸根 Context 上——把不安全的用法当成了示范。

## Decision

`scopeOf(agentCtx)` 为 undefined 时 `installModelSelection` 抛错，并在报错信息里说明原因。带标签但并非该 Agent 自身 scope 的上下文仍然被刻意允许：那种准入是显式的 scope 链选择，而非静默的进程级全局。

## Alternatives considered

- **检查 `agentCtx.agent` 而非 scope 标签。** 无标签上下文可以通过普通 `extend` 携带该访问器；访问器不能证明准入范围。
- **告警但仍安装。** 这种误用的后果是静默的跨会话路由损坏；告警等于把故障留在原地。

## Consequences

误用现在在安装期失败，而不是变成进程级全局监听器。此前在无标签上下文上构造桩 agent 的六处测试基建——`dsh-host-apiproxy` 的 models、agent-preset、cold、fork 四个 spec，`dsh-bundle-headless` 的 runner spec，以及包 spec 自身——现在都构建真实的 scope key；它们此前一直在无声明地通过全局准入驱动这些监听器。`dsh-bundle-headless` 新增 `dsh-scope` 作为仅测试用的 devDependency。

## Testing

包 spec 覆盖拒绝分支，并在真实 scope key 上重新钉住快照／dispose 行为；六处改造后的 harness 与受影响包的其余测试在守卫下全部通过。
