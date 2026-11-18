# 14 · ToolCapability 与只读工具示例（E1）

> 状态：PA-13 的部分实现。`TOOL_CONTRACT_VERSION = 1`、Provider 配置校验、Runtime/Channel 契约版本已落地，但在 D11 决策前均属 **experimental**；第二真实 Provider、通用入站 ChannelAdapter 与真实 G1 验证仍 pending。所有写操作必须经过 ActionService；禁止注册通用 Shell。

## 接口

`ActionTool`（`apps/agent/src/actions/tools.ts`）当前约定：

| 字段 | 规则 |
| --- | --- |
| `name` | 全局唯一工具名；任务 Mandate 必须精确列出 |
| `resource` | 可选；声明后 `mandate.resources` 必须包含，否则提案/执行都被拒绝；不声明则跳过资源校验（仅受 `mandate.tools` 约束） |
| `readOnly` | 只读工具为 `true`；超时按 failed，不进入 unknown 重放 |
| `replayPolicy` | 写工具必须声明 `"verify"` 才允许在 verify 明确不满足后重试；默认/`"never"` 直接 needs_manual |
| `timeoutMs` | 单次调用上限；默认 15s，GitHub 10s，mock 灯 5s |
| `canonicalize` | 程序校验参数；失败抛 `ToolRejectedError`，不得信任 Prompt |
| `execute` | 返回 evidence/externalRef；写操作由 ActionService 领取、审批、审计 |
| `verify` | 只读工具返回 `satisfied:false` 让 reconcile 重新读取；写工具必须能核对真实外部状态 |
| `description` | 可选的人类说明；不参与权限判断 |

`ToolRegistry.describe()` 返回已注册工具的 `name/resource/readOnly/replayPolicy/timeoutMs` 元数据，供宿主诊断；真正参数校验仍由 `canonicalize` 完成，不能只依赖描述。

## 最小只读工具

```ts
import { ToolRejectedError, type ActionTool } from "../apps/agent/src/actions/tools.ts";

export class ClockTool implements ActionTool {
  readonly name = "time.now";
  readonly resource = "clock";
  readonly readOnly = true;
  readonly replayPolicy = "verify" as const;
  readonly timeoutMs = 2_000;

  canonicalize(args: Record<string, unknown>): Record<string, unknown> {
    if (Object.keys(args).length > 0) {
      throw new ToolRejectedError("time.now takes no arguments");
    }
    return {};
  }

  async execute() {
    return { evidence: { now: new Date().toISOString() } };
  }

  async verify() {
    // 只读没有本地状态可核对；让 reconcile 重新执行读取。
    return { satisfied: false, evidence: { readOnly: true } };
  }
}
```

## 注册

通过 `createApp` 的 `registerTools` seam 注入，不改业务状态机：

```ts
const app = createApp({
  store,
  runtime,
  wake,
  model,
  registerTools: (registry) => registry.register(new ClockTool()),
});
```

任务 Mandate 必须同时允许工具与资源：

```json
{ "resources": ["chat", "clock"], "tools": ["time.now"] }
```

缺少 `clock` resource 时，ActionService 在提案阶段以 `resource_outside_mandate` 拒绝。审批仍按现有 Action 流程执行；只读自动预授权是待定策略，不在本文默认。

> `PiRouterModel` 只接受 `ALLOWED_TOOLS` / `ALLOWED_RESOURCES` 白名单内的工具与资源。使用默认模型宿主时，须把新工具加入该白名单，或由宿主注入自定义 `RouterModel`；否则模型生成的任务 Mandate 会被 sanitize 掉，提案以 `tool_outside_mandate` 拒绝。`registerTools` 不允许覆盖已注册的 built-in 工具名。

## Provider / Runtime / Channel 契约（E1）

- `MODEL_PROVIDER` 默认 `opencode-go`，未知值在启动前抛 `ConfigError`；`OPENCODE_MODEL` 固定模型。当前只注册了 opencode-go Provider，第二个真实 Provider 需先决定凭据与兼容性。
- `RUNTIME_CONTRACT_VERSION = 1` 标注 `AgentRuntime` seam；Node/DO 均只通过 `createApp` 注入 Runtime/Wake/Store，不复制业务状态机。
- `CHANNEL_CONTRACT_VERSION = 1` 是出站 `ChannelAdapter` 契约：`send` 必选，`findByBusinessKey` 可选；无查询能力时必须进入 unknown/needs_manual，不能声称已送达。入站解析目前是飞书参考实现，通用入站契约仍 pending。
- 这些版本号当前只用于实验期兼容检查，不构成稳定 API 承诺；是否转为 v1 稳定由 D11 决定。版本变更需附迁移说明，且不得静默改变 `send` 的幂等/异常语义。

## 测试

`apps/agent/test/tool-capability.test.ts` 覆盖：

- 独立注册后可通过 Mandate 允许的提案、审批、执行；
- 缺少 resource 时提案被拒绝；
- 工具名/资源由程序校验，不依赖 Prompt。
