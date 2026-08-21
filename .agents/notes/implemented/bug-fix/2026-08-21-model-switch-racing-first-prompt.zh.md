# Agent Note: 已接受的模型切换必须抵达其后发出的提示所在回合

Status: implemented

[English](2026-08-21-model-switch-racing-first-prompt.md) | 中文

## Problem

`sessions.selectModel` 先经一次 await 的 `resolveCallConfig` 校验请求的路由，之后才写入该会话的 picked 选择，而 `sessions.prompt` 派发回合时与这次写入没有任何顺序约束。于是，在切换之后发出的提示可能先启动回合、完成 assembly，在切换写入落定前读到选择的回退档。回合随后吃到哪一档取决于该会话自身的历史：有 `request/header` 日志的会话回退到自己上一次的模型，一次被接受的切换被静默跳过该回合；空白会话则回退到实时的进程默认档——任意会话的每次切换都会写它——于是空白会话的首个回合跑在一个该会话从未选择过的模型上，而它自己的切换明明已被接受。

把图片校验与模型选择排序的每-agent 串行链正是为这种顺序存在的，但 `sessions.prompt` 只在带图片内容时进入它；纯文本提示未串行即派发。该缺陷要求同一 agent 同时有一个切换和一个提示在途，这正是顺序「先切换后提示」的客户端从未看到它的原因。

## Decision

每一条 `sessions.prompt` 准入——无论文本还是图片——都经过这条每-agent 链（现名 `serializeSelectionAdmission`）：模型切换、图片能力校验、回合派发按 agent 排序。RPC 的发出顺序决定结果：在提示派发之前被接受的切换先落定，再轮到该回合的 assembly 读取选择；派发之后到达的切换维持文档化的「下次 assembly 生效」语义。`dsh-agent` 模型选择监听器的 assembly 快照契约不变，sticky default 本身也维持原设计——从未切换过的空白会话仍读取已保存的默认档。

进入链的顺序是确定性的而非时序运气：两个 RPC 都经由同一条 `agentFor` promise 链解析 agent，续延顺序决定链内顺序。

## Alternatives considered

- **先写 picked 再校验、拒绝时回滚。** 短暂未校验的选择会暴露给并发的 assembly，可能把一个 `prepareCall` 随后拒绝的回合路由出去；接受必须先于可见。
- **在 assembly 监听器内等待在途切换。** `ModelSelectionRef.current` 是同步接口，为网关侧的排序问题把它改成异步会重塑 `dsh-agent` 缝隙。
- **在 `turnAgentFor` 内串行。** 派发（`followup`/`steer`）发生在 `turnAgentFor` 返回之后的处理器里，处理器的准入体才是串行单元。
- **把收件箱队列项的 steer 拉进链。** 它只注入已在运行的回合，无法开启新的 assembly，排序它毫无收益。

## Consequences

并发发出切换与提示的客户端现在得到「先到先得」的顺序，而不是依赖交错时序的模型；空白会话的首个回合点名它已接受的切换所选的模型，而非进程内最近一次任意切换留下的模型。顺序流程不变。`turnAgentFor` 的路由可用性拒绝检查仍在进入链之前读取选择，因此「保存的默认档指向不可路由的路由 + 并发切换到可路由路由」仍可能基于过期读取拒绝一条提示——同类问题，在此记名，不在本次修复。

## Testing

`packages/host/apiproxy/tests/api-proxy-model-isolation.spec.ts` 跑真 AgentLoop 工厂、真 scope key、真 RPC 面，重启场景用真 JSONL 持久化。它钉住：自然时序的跨会话隔离、空白会话跟随已存默认档、重连时 `session.create` 与切换的竞态收敛到驱动 agent、重启后切换与首提示竞态、以及污染组合——外来 sticky 默认档 + 已接受切换 + 并发首提示在切换所选模型上应答。两个竞态测试在修复前的树上失败、修复后通过；压力跑保持绿色，因为该顺序建立在微任务 FIFO 上，而非调度运气。
