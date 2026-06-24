# 贡献者阅读路径

本文是 contributor 和 reviewer 的实用阅读路径。它不替代模块文档或测试；它告诉你在触碰 WDL 某个部分前应先读哪个合同。

## License And Contributions

WDL 采用 Apache License, Version 2.0。除非你明确声明其他条款，否则你有意提交到本项目的 contribution（定义见 Apache-2.0 license）均以 Apache-2.0 授权，不附加额外条款或条件。

普通 contribution 不要求版权转让。

## 第一遍阅读

做跨模块改动前按顺序阅读：

1. `docs/architecture.zh.md`：服务、状态、信任边界和 rollout 形态。
2. `docs/security.zh.md`：trust zone 和 private mesh 假设。
3. `docs/project-standards.zh.md`：跨语言 error、observability、validation 和 review 规则。
4. `docs/protocol-contracts.zh.md`：schema、payload、binding registry 和 state-machine protocol 方向。
5. `docs/source-map.zh.md`：定位 owning source tree。
6. `docs/modules/` 下的 owning module doc。
7. `docs/testing.zh.md`：最小有效检查和 PR/integration gate。
8. `CLAUDE.md`：agent 和 maintainer 的短 invariant checklist。

## 改动 Playbook

### Control Route 或 Admin API

先读 `docs/modules/control-auth.zh.md`、`docs/project-standards.zh.md` 和 `docs/protocol-contracts.zh.md`。`parseControlRoute()`、auth action mapping、handler、error/return contract、docs 和行为测试应一起更新。Handler 内不要从 URL prefix 自己推断权限。

Control helper 和 route/error shape 用单测保护。Route reachability、auth、lifecycle、deploy、promote、delete 或 host 行为变化时，跑定向 control/auth 或 gateway integration。

### Runtime Binding 或 Bundle Metadata

先读 `docs/modules/runtime.zh.md`、`docs/protocol-contracts.zh.md`，以及存在时的具体 binding 模块文档。一个 binding 改动必须同时考虑 deploy validation、bundle metadata、runtime env materialization、hidden backend binding、wrapper 行为、tenant-visible facade shape、docs 和 tests。

不要在没有判断 registry entry 归属的情况下再加本地 switch 分支。运行 runtime/load 单测、facade 测试，以及受影响 binding 的定向 integration。

### Redis Key 或 Payload

先读 `docs/redis-key-layout.zh.md` 和 `docs/protocol-contracts.zh.md`。Redis key 应走共享 helper；payload 需要一个 writer owner 和已记录的 reader。Index 和 projection 应命名 authoritative record 与 stale cleanup path。

运行 source-scan drift guard，以及每对 writer/reader 的行为测试。Redis state shape 影响 runtime 行为时，跑定向 integration。

### D1、DO、Scheduler 或 Workflows State Machine

先读 owning module doc、`docs/protocol-contracts.zh.md`，涉及 Rust 时再读 `docs/rust-sidecar-standards.zh.md`。编辑前先找出 generation、lease、token、WATCH 或 run-token fence。触碰 stale writer、owner handoff、retry、drain、due index 或 lifecycle blocker 时，补 model-ish 或 failure-injection 测试。

运行 crate-local Rust tests 和跨 service boundary 的最小 integration 文件。Redis shape 或 runtime 行为变化时，commit-ready 前跑完整 integration。

### Observability

先读 `docs/modules/log-tail-observability.zh.md` 和 `docs/project-standards.zh.md`。日志承载 snake_case 诊断上下文；metrics 只承载有界 label。重命名 log field、event、metric family 或 label 都是合同变更，必须同步更新 docs 和 tests。

### Infrastructure 或 Delivery

先读 `docs/modules/infra.zh.md`、`docs/security.zh.md`、`docs/testing.zh.md` 和相关部署 manifest。保持 private service socket 不公开，保留 image/runtime contract；validation path 变化时同步更新 CI 或 runbook 文档。

## Review Checklist

Stage 前确认：

- behavior、protocol、Redis ownership 或 deployment shape 变化时，owning active doc 已更新；
- 英文和中文文档成对移动；
- 新 payload shape 有一个 writer owner 和已记录 consumer；
- hidden credential、internal Fetcher 和 internal auth header 不变成 tenant-visible；
- error response 遵守所属协议域；
- logs 和 metrics 保持 bounded-label / sensitive-data 合同；
- 测试覆盖改变的边界，而不只是触碰的实现行。

把 staged changes 当作 review boundary。Review feedback 如果不正确或不值得 tradeoff，应保持代码不变，并解释使当前行为安全的合同。
