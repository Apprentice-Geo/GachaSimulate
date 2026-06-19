# Architecture

本文档记录当前模拟核心的架构、执行流程和维护边界。它描述的是现有实现，不是未来重构方案。

## 设计目标

当前架构服务于个人抽卡规则模拟：规则写在 JSON 配置中，运行前编译成更适合 Monte Carlo 热路径的数据结构，运行时尽量只做数组读写和 Action 执行。

主要取舍：

- 配置可读性优先于完整规则引擎能力。
- 运行时性能优先于高度动态的对象查询。
- 规则由可信维护者编写，部分循环和不可达终止风险交给配置约束处理。
- 架构保持简单，不为暂时不存在的规则类型预留复杂扩展层。

## 模块职责

- `simulate.validator`：校验 JSON 配置和终止条件。它负责字段类型、引用合法性、概率和为 1、动作类型、条件类型等静态规则。
- `simulate.builder`：把 JSON 配置编译为 `RuntimeContext`。编译过程会把 item id、pool id 转换成整数 index，构造 pool CDF、Action 对象、stage 条件树和 termination 条件树。
- `simulate.runtime`：定义运行期数据结构，包括 `RuntimeContext`、`RuntimeState`、Action、Condition、Stage、Pool、Item。
- `simulate.engine`：执行单次模拟。`MonteCarlo.run_once()` 在 `RuntimeState` 上执行抽卡循环，直到 termination action 设置终止状态。
- `simulate.core`：执行批量模拟、并行模拟、结果保存、结果加载和可视化输入生成。

核心数据流：

```text
config.json + termination.json
    -> validator
    -> RuntimeBuilder
    -> RuntimeContext
    -> MonteCarlo.run_once()
    -> RuntimeState
    -> core 聚合为 npz / visualize input
```

## RuntimeContext 与 RuntimeState

`RuntimeContext` 是单次或多次模拟共享的只读上下文。它包含编译后的物品、奖池、动作、阶段和终止条件。`draw_count_index` 指向配置中显式声明的 `draw_count` item。

`RuntimeState` 是一次模拟 run 的可变状态。它包含：

- `inventory`：规则判断用库存。
- `acquired`：统计用累计获得数量。
- `reduced`：统计用累计消耗数量。
- `main_pool_index`：当前主奖池。
- `stage_execute` 和 `active_stage_indices`：stage 执行状态。
- `terminate` 和 `terminate_reason`：终止状态和原因。

`draw_count` 是普通 item，不是 `RuntimeState` 字段或 property。当前 run 已执行抽数通过 `inventory[ctx.draw_count_index]` 读取。

这种拆分的好处是：配置编译只做一次，Monte Carlo 热路径只创建轻量 `RuntimeState`，并通过整数 index 访问 NumPy 数组。

## Action 机制

当前 Action 是运行时最小执行单元。主要类型包括：

- `AddItem`：增加库存和累计获得。
- `ReduceItem`：减少库存并增加累计消耗。
- `SetItem`：直接设置库存，不影响累计获得或累计消耗。
- `DrawPool`：从指定奖池抽取一次，返回该条目的 actions。
- `PoolChange`：切换主奖池。
- `Termination`：设置终止状态和终止原因。

需要注意的是，Action 的协议并不完全对称：

- 大多数 Action 直接修改 `RuntimeState`。
- `DrawPool.execute()` 返回后续 actions，由 engine 继续执行。
- `AddItem` 除了修改状态，还会由 engine 触发该 item 的 `on_acquire` actions。

因此，`Action.execute()` 不是完整的解释器入口；真正的 Action 调度规则在 `MonteCarlo._execute_action()` 中。engine 通过 Action 的整数 `kind` 标记分派，不在热路径使用 `isinstance` 判断。这个设计足够直接，但新增 Action 类型时要先判断它只是修改状态，还是会产生后续动作。

## 单次模拟执行流程

`MonteCarlo.run_once()` 每次创建新的 `RuntimeState`，设置初始主奖池和 stage 状态，执行 `initial_actions`，然后循环执行单抽周期。

单抽周期顺序固定为：

1. `inventory[ctx.draw_count_index] += 1`。
2. 从当前主奖池抽取一次。
3. 执行 stage phase。
4. 执行 resolve phase。
5. 检查 termination tree，满足时执行 termination actions。

这个顺序是架构契约的一部分。配置中的 stage 和 termination 条件都依赖这个顺序解释。

## Stage Phase

stage 是每抽后的规则检查点。每个 stage 有一个 condition，condition 满足时执行其 actions。

当前规则：

- `once: true` 的 stage 触发后会从 `active_stage_indices` 移除，后续抽数不再检查。
- `once: false` 的 stage 每次满足条件都会执行。
- 同一轮中，前一个 stage 的 actions 会影响后一个 stage 的 condition。
- stage 的执行顺序来自配置中 `stages` 对象的顺序。

维护时应避免依赖不明显的 stage 顺序。如果两个 stage 有强顺序依赖，建议在配置命名或文档中明确说明。

## Resolve Phase

resolve 用于把超出保留数量的物品分解成其他资源。当前实现会按 item index 顺序扫描所有带 resolve actions 的物品。

对每个可分解物品：

1. 读取当前库存。
2. 计算保留数量：`max(resolve.retain, retained_items 中的隐式保留 1)`。
3. 对超出保留数量的每个物品执行一次 resolve actions。

重要约束：

- resolve phase 不是固定点循环，只扫描一轮。
- 如果某个 resolve action 产生另一个也需要 resolve 的物品，是否在同一轮处理取决于 item 顺序。
- 如果 resolve action 产生已经扫描过的可分解物品，它不会在当前轮再次分解。

因此，当前配置应避免让 resolve 产生仍需 resolve 的物品。这个约束现在主要由配置作者维护，而不是 validator 强制维护。

## Condition Tree

condition tree 支持两类节点：

- `predicate`：读取指定 item 库存，与目标值比较。`draw_count` 判断也写作普通 item predicate。
- `logic`：支持 `AND` 和 `OR`。

builder 会把 predicate 的 item id 编译为 item index。engine 执行 condition 时直接读取 `state.inventory[node.item_index]`，不再做 subject 分派。Condition 节点同样通过整数 `kind` 标记分派。

Action 聚合规则：

- `OR` 会短路，遇到第一个满足的 child 后，执行当前 logic node actions，再执行该 child actions。
- `AND` 必须全部 child 满足，按 child 顺序聚合 actions，最后执行当前 logic node actions 加聚合后的 child actions。
- predicate 满足时只返回自己的 actions。

termination tree 经过 validator 约束，只允许 termination actions。stage condition 则允许普通 actions。

## 批量与并行模拟

`simulate_until_total_draw()` 以目标总抽数为停止条件，而不是以目标 run 数为停止条件。单次 run 的抽数可能超过剩余目标，因此最终 `total_draw` 可以大于请求值。

单进程模式直接复用一个 `MonteCarlo` 实例，因此 RNG 会在多次 `run_once()` 之间连续推进。

多进程模式会：

1. 按 worker 数拆分目标抽数。
2. 用主 seed 生成 `SeedSequence`。
3. 为每个 worker spawn 子 seed。
4. 每个 worker 独立构造 `MonteCarlo` 并模拟到自己的目标抽数。
5. 合并各 worker 的 `draw_count`、`lifetime_acquired`、`terminate_reasons`。

并行结果与单进程结果不保证逐 run 相同，但在 seed 固定时应可复现同一并行配置下的结果。

## 当前隐含不变量

这些不变量不是全部由代码强制保证，但当前架构依赖它们：

- termination condition 最终可达，否则 `run_once()` 会一直运行。
- `on_acquire` action 图不应形成无限递归。
- resolve actions 不应产生需要继续 resolve 的物品，除非接受 item 顺序带来的延迟行为。
- pool entry 概率和为 1，且 builder 会把 CDF 最后一项强制设为 1.0。
- 配置对象顺序有语义：items 顺序决定 index，stages 顺序决定执行顺序。
- `RuntimeContext` 在模拟过程中按只读对象使用。

## 已知风险

### Action 调度语义分散

Action 类定义了 `execute()`，但真正的调度语义在 engine 中。尤其是 `AddItem` 的 `on_acquire` 触发和 `DrawPool` 的后续 action 展开，都不是 Action 基类协议能直接表达的。

短期维护建议：新增 Action 时同步检查 `MonteCarlo._execute_action()`，不要只实现 `execute()`。

长期可选方案：统一 Action 协议，让所有 Action 执行后返回后续 actions，engine 用队列消费 actions。

### Resolve 只扫描一轮

当前 resolve phase 简单高效，但不适合复杂分解链。若未来出现分解产物也需要自动分解的规则，可以考虑：

- validator 禁止 resolve 产生可 resolve item。
- 或把 resolve 改成固定点循环，并加最大迭代保护。

在当前规则规模下，优先建议维持现状并显式记录配置约束。

### 缺少单 run 最大抽数保护

如果 termination 不可达，`run_once()` 没有 fail-fast 机制。个人可信配置下这可以接受。

如果未来配置数量继续增加，建议增加可选 `max_draw_per_run`，只在调试或批量验证时启用。

### 内存随 run 数增长

批量结果会保存每次 run 的 `draw_count`、`lifetime_acquired` 和 `terminate_reasons`。其中 `lifetime_acquired` 是二维数组，run 数和 item 数都变大时会占用较多内存。

如果未来只关心分位数、CDF 和终止原因比例，可以考虑流式聚合或直方图聚合。但当前可视化和统计仍需要 per-run 数据，暂时不建议改。

## 演进建议

当前项目已经满足个人使用需求，优先级最高的不是重构，而是把行为契约写清楚。建议按以下顺序演进：

1. 保持现有架构，维护本文档和测试用例，让配置语义稳定。
2. 为危险配置补 validator 检查，例如 `on_acquire` 环和 resolve 产物约束。
3. 当 Action 类型继续增加时，再考虑统一 Action 调度协议。
4. 当数据规模导致内存压力时，再考虑流式聚合结果。

换句话说，当前架构适合继续使用。需要警惕的是把它扩展成通用规则引擎时，Action 调度和 resolve 语义会先变成复杂度来源。
