# 文档索引

这个目录用于承载项目设计文档和开发约束文档。当前代码和测试仍然是事实来源；文档的作用是解释当前实现、实现依赖的合同，以及后续开发必须保留的约束。

## 从这里开始

- [架构概览](architecture.zh.md) 给出服务、状态、信任边界和 rollout 的高层地图。
- [安全模型](security.zh.md) 记录当前 trust zone、tenant/runtime 边界、internal mesh 假设和基础设施安全合同。
- [Workers 兼容矩阵](compatibility.zh.md) 记录 supported、partial 和 unsupported 的 Workers surface。
- [Redis key layout](redis-key-layout.zh.md) 记录跨模块 Valkey DB split、全局控制面 key 和 key ownership 规则。
- [协议合同](protocol-contracts.zh.md) 记录 schema、payload、binding registry、state-machine test 和 known-constraint runbook 口径。
- [Source map](source-map.zh.md) 记录当前源码树 ownership map。
- [模块文档地图](modules/README.zh.md) 列出当前模块级设计文档，以及每个模块可参考的材料。
- [CLI 和 Wrangler 输入](modules/cli.zh.md) 记录 `wdl` 命令面、Wrangler config 子集和 bundling 合同。
- [测试](testing.zh.md) 记录 unit、typecheck、integration 和 runner artifact 合同。
- [贡献者阅读路径](contributing.zh.md) 记录修改 control route、binding、Redis payload、state machine、observability 或 delivery path 前应读哪些合同。
- [项目全局标准](project-standards.zh.md) 定义共享合同、安全边界、可观测性、JS、Rust、测试、文档和部署代码之间的跨语言约定。
- [Workerd JavaScript 标准](workerd-js-standards.zh.md) 定义 JavaScript/workerd tier 的结构和测试标准。
- [Rust service 和 sidecar 标准](rust-sidecar-standards.zh.md) 定义 Rust crate 的结构和测试标准。

## 模块文档

当前模块文档以及每个模块的刷新输入见 [模块文档地图](modules/README.zh.md)。

## 文档规则

- 同一范围的英文和中文文档应保持相近的信息深度。
- 内部文档优先写设计契约和约束，而不是面向用户的使用教程：ownership、接口、Redis/storage key、失败语义、部署顺序、可观测性和测试锚点。
- 文档工作按模块或跨模块关注点分批处理。
- 开发约束应靠近它保护的模块，方便后续修改前找到相关 invariant。
