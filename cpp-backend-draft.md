# GachaSimulate C++ Backend / TypeScript Compiler 设计草案

## 1. 目标

将当前 Python 模拟后端逐步替换为：

```text
YAML Configuration
        ↓
TypeScript Validator / Compiler
        ↓
JSON IR
        ↓
C++ Runtime Loader
        ↓
RuntimeProgram
        ↓
Multi-thread Monte Carlo Simulation
        ↓
.gsr
```

主要目标：

1. TypeScript 负责配置解析、校验和编译。
2. C++ 只负责执行已经确定语义的 IR。
3. 提高 Monte Carlo 模拟性能。
4. 保持配置 DSL 与执行引擎解耦。
5. 保留 Electron 与模拟后端之间清晰的进程边界。
6. 首版优先保证语义正确、架构稳定，暂缓不必要的底层优化。

------

# 2. 组件职责

## 2.1 TypeScript Compiler

实现为独立的纯 TypeScript 包，例如：

```text
@gachasimulate/config-compiler
```

它不依赖 Electron、网络、ZIP 或宿主文件系统。Electron Main、命令行入口和独立配置仓库负责读取文件，再把 YAML 文本和未知对象交给该包。

负责：

- YAML 解析。
- 配置结构校验。
- termination 配置校验。
- 默认值补全。
- item / pool 等符号解析。
- 将名称引用转换为整数 ID。
- Action 编译。
- Condition 编译。
- Rule 编译。
- probability / weight 归一化。
- Pool CDF 生成。
- 输出 JSON IR。

YAML 输入契约同时要求：

- `config.yaml` 包含受支持的 `schema_version`；termination 继承该版本。
- `config.yaml` 和 termination 文件只包含模拟语义字段，禁止 `metadata` 和其它未知根字段。
- 名称、描述、metrics、termination 展示名及来源说明属于 `manifest.yaml`，不进入模拟编译。
- `draw_count` 是只读内建变量，不在 `items` 中声明，也不能被 Action 修改。
- 重复 YAML key、非有限数、不安全整数、重复 retained item 和 `repeat` 的无 Action 成功路径在编译期拒绝。

原则：

> 所有可以静态完成的工作尽量在编译阶段完成。

C++ Runtime 不应知道：

- YAML 语法。
- `weight` 和 `probability` 的区别。
- item/pool 的字符串引用方式。
- YAML 默认值规则。
- DSL 的语法糖。
- manifest 或配置仓库元数据。

Compiler 在 lowering 时为 `draw_count` 注入固定的 synthetic runtime item slot。condition 继续使用普通整数 item ID 读取它，Runtime 每轮递增该 slot；源 YAML 和普通 Action 都不能声明或写入这个保留 ID。

------

# 3. IR

## 3.1 首版格式

使用 JSON。

示意：

```json
{
  "ir_version": "0.1.0",
  "items": [],
  "pools": [],
  "rules": [],
  "initial_actions": [],
  "every_draw_actions": [],
  "item_resolves": [],
  "termination": {}
}
```

必须包含：

```text
ir_version
```

C++ Loader 首先检查版本。

版本检查只是第一道校验。Loader 还必须拒绝：

- 未知字段和未知枚举值；
- 越界的 item、pool、rule、condition 和 ActionRange 引用；
- 溢出的 `begin + count`、数组长度和整数转换；
- 非有限、非单调或末项不为 `1.0` 的 CDF；
- 非法 condition child range、空逻辑节点及超过实现限制的输入规模。

IR 文件即使由官方 TS Compiler 生成，进入原生进程时仍视为不受信任输入。

------

## 3.2 IR 的定位

IR 是：

> TypeScript Compiler 与 C++ Runtime 之间的跨语言语义契约。

IR 不要求与 C++ 最终内存布局完全一致。

因此推荐：

```text
JSON IR
    ↓ deserialize / lower
C++ RuntimeProgram
```

JSON 优先：

- 可读。
- 容易调试。
- 容易生成测试 fixture。
- TS 原生支持。
- C++ JSON 库成熟。

RuntimeProgram 优先：

- 内存连续。
- 执行效率。
- 减少动态分配。
- 减少字符串访问。

------

# 4. Symbol Resolution

配置中的名称：

```text
item: character_a
pool: limited_pool
```

在 TS 编译阶段转换为整数 ID：

```text
character_a → item 3
limited_pool → pool 1
```

Runtime 热路径只使用：

```cpp
uint32_t
```

字符串名称保留在调试 / 输出 string table 中，用于：

- 日志。
- 错误信息。
- 输出。
- 调试。

避免 Runtime 使用：

```cpp
unordered_map<string, ...>
```

进行高频查询。

------

# 5. RuntimeProgram

`RuntimeProgram` 构建一次，此后只读。

多线程模拟共享同一个 RuntimeProgram。

总体采用：

> Arena + integer ID

思路。

示意：

```text
RuntimeProgram
├─ actions[]
├─ condition_nodes[]
├─ condition_children[]
├─ pools[]
├─ pool_entries[]
├─ rules[]
├─ item_resolves[]
└─ strings[]
```

其它对象通过：

```text
index
```

或者：

```text
begin + count
```

引用这些连续数组。

原则：

> Runtime 数据尽量连续，而不是大量小对象 + 指针。

------

# 6. Action IR / Runtime

当前 Action 类型集合是封闭的，因此首版 C++ 使用：

```cpp
std::variant
```

例如：

```cpp
struct AddItem {
    uint32_t item;
    int64_t amount;
};

struct ReduceItem {
    uint32_t item;
    int64_t amount;
};

struct SetItem {
    uint32_t item;
    int64_t value;
};

struct DrawPool {
    uint32_t pool;
};

struct ChangePool {
    uint32_t pool;
};

struct Terminate {
    uint32_t reason;
};

using Instruction = std::variant<
    AddItem,
    ReduceItem,
    SetItem,
    DrawPool,
    ChangePool,
    Terminate
>;
```

Action 的状态语义固定为：

- `AddItem` 增加库存，随后立即检查该 item 的 resolve。
- `SetItem` 设置库存，随后同样检查 resolve。
- `ReduceItem` 只减少库存，不触发 resolve。
- `ChangePool` 立即修改主 pool。
- `Terminate` 设置终止状态；执行器必须立即丢弃全部剩余父子 frame。

RuntimeState 不再维护未被产品消费的 `acquired` / `reduced` 统计。

首版不使用：

```text
virtual Action
+ unique_ptr<Action>
```

主要原因：

- Action 类型固定。
- `variant` 类型安全。
- 可以直接存储在连续 `vector` 中。
- 不需要每个 Action 单独 heap allocation。

未来如果 profiling 证明需要进一步优化，可以降低为：

```cpp
struct Instruction {
    OpCode opcode;
    uint32_t a;
    uint32_t b;
};
```

即更接近 bytecode 的固定长度指令。

首版不做。

------

# 7. Action Sequence

所有 Action 可以统一存入：

```text
actions[]
```

某段 Action Sequence 使用：

```text
action_begin
action_count
```

表示。

例如：

```text
actions:

0 AddItem
1 DrawPool
2 ReduceItem
3 ChangePool
4 Terminate
```

某个规则可能引用：

```text
begin = 1
count = 3
```

表示：

```text
actions[1..4)
```

------

# 8. Nested Action Execution

Action 设计上允许产生其它 Action，目前有以下 Action 会产生：

- `draw pool`
- `item_resolve`

语义要求：

```text
Parent actions:

A
DRAW
B
```

若 DRAW 产生：

```text
X
Y
```

执行顺序必须为：

```text
A
DRAW
X
Y
B
```

因此首版不采用：

```text
Action.execute() → new vector<Action>
```

而使用显式 ActionFrame 栈。

概念：

```cpp
struct ActionFrame {
    uint32_t begin;
    uint32_t count;
    uint32_t position;
    uint32_t repeat;
};
```

执行器：

```text
push parent frame

执行 DRAW
    ↓
push child frame

先完整执行 child
    ↓
pop

继续 parent
```

这本质上类似一个小型 call stack。

每次取下一条指令前都检查终止状态。任何深度的 child action 执行 `Terminate` 后，执行器直接清空 frame stack，不再返回父 sequence。

------

## 8.1 item_resolve repeat

如果 item resolve 需要执行 N 次：

不构造：

```text
actions * N
```

而是：

```text
ActionFrame
    range = resolve_actions
    repeat = N
```

避免复制大量 Action。

TS Compiler 为每个可分解 item 计算：

```text
effective_retain = max(config retain, termination retained_items)
reduce_per_batch = ResolveActions 中唯一 item -= n 的 n
```

`AddItem` 或 `SetItem` 完成库存修改后计算：

```text
repeat = max(0, floor((inventory - effective_retain) / reduce_per_batch))
```

只执行完整分解批次；因此当 `reduce_per_batch > 1` 时，库存可以比 retain 多、但不足一个完整批次。ResolveActions 仍按当前 DSL 约束包含且仅包含一个减少被分解 item 的 Action。

------

# 9. Condition

Condition 数据首版直接扁平化。

不在 Runtime 中构建：

```text
LogicNode*
  ↓
children pointers
```

而使用：

```text
condition_nodes[]
condition_children[]
```

示例：

```text
OR
├─ CHECK A >= 1
└─ AND
   ├─ CHECK B >= 2
   └─ CHECK C == 0
```

可以表示为：

```text
nodes:

0 OR
1 CHECK A
2 AND
3 CHECK B
4 CHECK C

children:

[1, 2, 3, 4]
```

节点：

```cpp
struct ConditionNode {
    ConditionKind kind;

    // Check
    uint32_t item;
    CompareOp op;
    int64_t value;

    // Logic
    uint32_t child_begin;
    uint32_t child_count;

    // Node actions
    uint32_t action_begin;
    uint32_t action_count;
};
```

实际实现可以根据 union / variant 等方式进一步优化字段布局。

------

# 10. Condition Execution

首版：

> 数据扁平化，但控制流仍然按 Node ID 递归/解释执行。

即：

```cpp
evaluate(node_id)
```

暂时不编译成：

```text
CHECK
JUMP_IF_FALSE
JUMP
...
```

这样的 jump bytecode。

原因：

- 当前 Condition 语义包含 Action 收集。
- AND / OR 有短路。
- Action 存在提交/放弃语义。
- jump bytecode 会明显增加首版复杂度。

先通过 C++ + flat arrays 去除 Python 对象树和递归对象访问开销。

之后 profiling 再决定是否继续 flatten control flow。

------

# 11. Condition Action Buffer

Condition 求值阶段：

> 只收集 Action，不修改 RuntimeState。

因此使用一个临时：

```cpp
pending_actions
```

保存匹配节点产生的 ActionRange。

收集顺序是现有 DSL 的一部分：

- 当前节点 ActionRange 先于 child ActionRange；
- `OR` 只保留第一个成功 child；
- `AND` 按声明顺序聚合所有成功 child；
- 整棵 condition 成功后才把收集结果交给 Action executor。

------

## 11.1 Checkpoint / Rollback

例如：

```text
AND
├─ A 成立 → action X
└─ B 失败
```

虽然 X 所属 child 成立，但整个 AND 失败，因此 X 不能执行。

进入 AND 时：

```cpp
auto checkpoint = pending_actions.size();
```

计算过程中临时追加：

```text
[A, B, C, X, Y]
```

如果 AND 最终失败：

```cpp
pending_actions.resize(checkpoint);
```

恢复：

```text
[A, B, C]
```

这相当于一个非常轻量的事务：

```text
checkpoint
↓
speculative collect
↓
success → commit
failure → rollback
```

rollback 的只是 Action Buffer。

不会 rollback RuntimeState，因为 Condition evaluation 本来就不能修改 RuntimeState。

------

# 12. Rule

Rule Runtime 本身尽量简单。

概念：

```cpp
struct Rule {
    RuleMode mode;
    uint32_t condition_root;
};
```

支持：

```text
once
per_draw
repeat
```

执行语义保持现有 DSL。

TS Compiler 对 `repeat` 做最低限度的静态进展检查：condition 的每条结构成功路径必须至少产生一个 Action。编译器不尝试证明任意 Action、嵌套 draw 或 resolve 一定改变条件；配置作者仍需保证 repeat 最终失败或终止。

首版 `once` 不做 active-rule-list 优化。

RuntimeState 中维护：

```cpp
vector<uint8_t> rule_executed;
```

每轮仍顺序遍历所有 Rule：

```text
once:
    已执行 → skip
    成功执行 → executed = 1

per_draw:
    每轮检查一次

repeat:
    成功 → 继续检查当前 rule
    失败 → 下一个 rule
```

以后 profiling 如果证明 Rule 遍历重要，再增加 active rule index list。

------

# 13. Pool

TS Compiler 将：

```text
probability
weight
```

统一 canonicalize 成 CDF。

例如：

```text
weights:

1
2
7
```

编译为：

```text
0.1
0.3
1.0
```

最后一个 threshold 强制设为：

```text
1.0
```

避免浮点累计误差。

------

## 13.1 Runtime Pool Layout

```text
pools[]
pool_entries[]
```

Pool：

```cpp
struct Pool {
    uint32_t entry_begin;
    uint32_t entry_count;
};
```

Entry：

```cpp
struct PoolEntry {
    double threshold;

    uint32_t action_begin;
    uint32_t action_count;
};
```

抽取：

```text
rng → [0, 1)
↓
std::lower_bound
↓
对应 entry
↓
执行 action range
```

首版保持 CDF + binary search。

------

# 14. RuntimeState

每次完整模拟创建自己的 RuntimeState。

概念：

```cpp
struct RuntimeState {
    uint32_t main_pool;

    std::vector<int64_t> inventory;

    std::vector<uint8_t> rule_executed;

    bool terminated;
    uint32_t terminate_reason;
};
```

`inventory` 包含 Compiler 注入的 synthetic `draw_count` slot。每轮主 pool 抽取开始时 Runtime 先递增该 slot，再执行用户配置的 `every_draw` actions；condition 可以按普通 item ID 读取它，Action IR 和 Loader 都禁止把它作为写目标。`every_draw` 没有其它工作时可以省略。

不使用：

```cpp
vector<bool>
```

因为它是 C++ 标准库的特殊 bit-packed specialization，并不是真正普通的：

```text
bool[]
```

首版使用：

```cpp
vector<uint8_t>
```

即可。

------

# 15. RuntimeProgram 与 RuntimeState 分离

最终模型：

```text
                RuntimeProgram
                shared / const
                     │
        ┌────────────┼────────────┐
        ↓            ↓            ↓
    Thread 0     Thread 1     Thread 2
       ↓            ↓            ↓
 RuntimeState   RuntimeState   RuntimeState
```

RuntimeProgram：

- 构建一次。
- 不可变。
- 所有线程共享。

RuntimeState：

- 每个 run 独立。
- 可变。
- 不在线程之间共享。

------

# 16. 并行模型

Electron Main 只启动：

```text
一个 C++ simulator process
```

C++ 内部使用多线程。

```text
Electron Main
      ↓
C++ Process
├─ Thread 0
├─ Thread 1
├─ Thread 2
└─ Thread N
```

原因：

- C++ 无 Python GIL。
- 避免多个 C++ 进程重复加载 IR。
- RuntimeProgram 可以共享。
- IPC 更简单。
- Electron 只需要维护一个进程生命周期。

------

# 17. Deterministic Map-Reduce

批量入口同时支持：

```text
fixed total runs
target total draw
```

任务预先分割为编号稳定的 chunk：

```text
chunk 0
chunk 1
chunk 2
...
```

线程调度和实际完成顺序不影响最终顺序。

例如：

```text
chunk 2 先完成
chunk 0 第二
chunk 1 最后
```

仍保存到：

```text
results[2]
results[0]
results[1]
```

最后固定按：

```text
0 → 1 → 2
```

进行 reduce / concatenate。

每个线程拥有：

```text
RNG
RuntimeState
ResultChunk
```

共享部分原则上只有：

```text
const RuntimeProgram
atomic progress
```

因此首版基本不需要锁。

固定 run 数按 run_count 拆分。累计抽数目标按 chunk 预分配 target，每个 chunk 连续完成完整 run，直到自己的累计抽数达到或超过 target；因此最终 `total_draw` 可以大于请求值。不得使用多个线程竞争同一个全局停止计数，否则调度顺序会改变结果集合。

------

## 17.1 可复现性

首版保证：

> 相同 seed + 相同线程数 / chunk 分配策略 → 相同结果。

不同线程数可能改变 RNG stream 分配，从而产生不同结果。

------

# 18. Electron ↔ C++ Process

沿用现有：

```text
SimulationTask
```

架构。

不重新设计 IPC。

------

## 18.1 Input

Electron Main：

```text
YAML
↓
compile
↓
temporary JSON IR
```

同一编译入口也由命令行包装层和配置仓库调用；编译逻辑不复制到 Electron Main。

然后：

```bash
gachasimulate-core \
    --ir compiled.json \
    (--total-runs ... | --target-total-draw ...) \
    --seed ... \
    --threads ... \
    --results-dir ...
```

配置内容通过 IR 文件传递。

控制参数继续使用 CLI 参数。展示 metric 不影响模拟，留在 TS 应用层，不传给 C++ core；core 在配置存在 cost item 时始终保存 cost section。

------

## 18.2 Output

stdout：

继续使用 JSONL。

保留事件：

```text
started
stage
progress
completed
error
```

例如：

```json
{"type":"started"}
{"type":"stage","stage":"simulating"}
{"type":"progress","completed":500000,"total":1000000,"unit":"runs"}
{"type":"completed","result_path":"...","total_runs":1000000,"total_draw":50000000}
```

`stage` 只允许 `loading_config`、`simulating`、`saving`；progress unit 只允许 `runs` 或 `draws`。没有持久化 visualize sidecar，因此 completed 不包含 `visualize_path`。

stderr：

用于普通 C++ 日志、诊断、崩溃信息。

------

## 18.3 Cancel

继续通过 Electron 终止整个 C++ process。

C++ 内部所有线程随进程一起退出。

无需首版额外设计线程级 cancellation protocol。

------

# 19. Simulation Result

废弃 NumPy `.npz` 和 `_visualize.json` sidecar。

原因：

- C++ 原生支持较差。
- 需要额外 NPZ / NPY 实现。
- 与纯 C++ Runtime 不匹配。

新的输出：

```text
result.gsr
```

C++ core 只保存原始模拟结果。独立 C++ result 模块统一维护 GSR 编解码和统计，`gachasimulate-analyze` 按需生成纯分析 JSON；统计不进入 core 的执行路径。

------

# 20. GSR Binary Format

`.gsr` 保存完整原始模拟数据。

目标：

- 简单。
- 连续。
- C++ 直接读写。
- 高效。
- 保留每次模拟结果。

概念布局：

```text
Header
────────────────
magic
version
run_count
item_count
seed
flags
...

draw_count[]
cost[]
terminate_reason_id[]

string table
```

`cost[]` 由 flags 表示是否存在。首版不保存 `lifetime_acquired` 或 `lifetime_reduced`。

在实现 writer 前，GSR v1 必须先固定完整 header、字段类型、section 顺序或偏移、数组 shape、字符串编码与长度、缺省字段表示和读取上限。TS reader 与 C++ writer 使用同一组语言无关 fixture 验证字节级契约，不能把这些决定留到 writer 实现阶段。

------

## 20.1 基本格式原则

必须从 v1 开始固定：

### Magic

例如：

```text
GSR
```

用于确认文件类型。

### Version

例如：

```text
version = 1
```

读取时检查版本。

### Fixed-width integer

文件格式禁止依赖：

```cpp
int
long
size_t
```

使用：

```cpp
uint8_t
uint32_t
int32_t
uint64_t
int64_t
```

### Endianness

v1 明确规定：

```text
little-endian
```

### Array length

所有数组长度必须：

- 在 Header 中明确记录；
- 或能够由 `run_count / item_count` 精确推导。

------

# 21. GSR 写入

不要直接：

```cpp
out.write(
    reinterpret_cast<char*>(&whole_struct),
    sizeof(whole_struct)
);
```

作为持久化协议。

原因：

C++ struct 可能包含：

```text
padding / alignment
```

不同编译器和 ABI 下不保证相同布局。

推荐用显式 little-endian helper 逐字段编码。

例如：

```cpp
std::ofstream out(path, std::ios::binary);

out.write("GSR", 3);
write_u32_le(out, 1);
write_u64_le(out, run_count);
```

连续数组：

```cpp
out.write(
    reinterpret_cast<const char*>(draw_count.data()),
    draw_count.size() * sizeof(int32_t)
);
```

连续 Runtime/Result 数据只有在元素宽度与文件契约一致且宿主为 little-endian 时才能直接一次性写入；否则先编码到连续字节 buffer。Reader 同样按文件字节序解码，不依赖宿主布局。

------

# 22. Terminate Reason

运行过程中使用：

```text
reason_id
```

而不是每条结果保存字符串。

例如：

```text
String Table:

0 → "completed"
1 → "pity_limit"
2 → "budget_limit"
```

每条模拟结果：

```text
[0, 0, 1, 0, 2, ...]
```

保存为：

```text
uint32[]
```

减少文件体积，也提高处理效率。

------

# 23. C++ GSR Result Module / Analyzer

独立 C++ result 模块统一维护 GSR v1 writer、reader 和统计。`gachasimulate-core` 只使用 writer；`gachasimulate-analyze` 读取 GSR 中的 draw count、可选 cost 和 terminate reason sections，按需计算：

- CDF；
- P5 / P25 / P50 / P75 / P95；
- min / mean / max；
- mean level；
- termination reason distribution；
- total runs / total draw / total cost。

analyzer 只接受 `draw` 或 `cost`，不接收 TS 推导的任意物品索引。GSR 自身固定统计 section 的身份；首版不保存或统计任意运行时物品。

analyzer 把单个版本化纯分析 JSON 写到 stdout，普通诊断写到 stderr。TypeScript 结果适配器校验其版本、字段、未知字段和数值范围，合并通用标题、固定说明、空价格/单位和 GSR 文件修改时间，形成内存中的 `VisualizeInput`，继续进入既有 validate、normalize、view model、Electron 展示和素材导出链路。GSR 不保存展示元数据；首版不生成 sidecar，结果展示信息编辑及其持久化协议后置。

GSR reader 必须执行与 C++ Loader 风险相称的 magic、version、长度、偏移、UTF-8 和资源上限校验。统计保持现有 Python 的线性 percentile 后取整、mean 取整及 termination 百分比最大余数分配规则；转为 `VisualizeInput` 前必须拒绝超出 JavaScript 安全整数范围的 totals、CDF 值和统计量。首版只对所选 metric 做一次内存排序；只有代表性 GSR 的测量证明必要后，才增加 mmap、分段读取或额外缓存。

------

# 24. 首版暂缓的优化

以下不进入第一版：

### Runtime

- Condition jump bytecode。
- 完整 VM / program counter。
- 固定宽度 opcode bytecode。
- active rule index 优化。
- Pool Alias Method。
- SIMD。
- mmap RuntimeProgram。
- lock-free result pipeline。

### IR

- Protobuf。
- FlatBuffers。
- MessagePack。
- 自定义 Binary IR。

### Reproducibility

- 不同线程数之间完全一致的随机结果。

### Result File

- 压缩。
- checksum。
- mmap GSR。
- 多版本兼容框架。
- TLV / schema evolution。
- Arrow / Parquet / HDF5。

只有 profiling 或实际需求证明必要后再增加。

------

# 25. 核心架构原则

整个设计首版遵循以下原则。

### Compiler 做静态工作

```text
YAML syntax
↓
semantic IR
```

C++ 不处理源语言细节。

### IR 表达语义

而不是简单序列化 YAML AST。

### IR 与 Runtime Representation 分离

```text
Readable JSON IR
↓
Efficient C++ RuntimeProgram
```

### Flatten Data First

优先把：

```text
objects + pointers
```

转为：

```text
arrays + IDs
```

暂时不急着 flatten control flow。

### Immutable Program + Mutable State

```text
RuntimeProgram = shared immutable

RuntimeState = per-run mutable
```

为多线程天然提供良好的所有权边界。

### Process Isolation + Thread Parallelism

```text
Electron
↓
one C++ process
↓
multiple threads
```

### Optimize After Profiling

首版优先：

```text
语义正确
架构清晰
可测试
可替换
```

避免提前引入 VM、复杂二进制协议等优化。

------

# 26. 首版最终数据流

完整流程：

```text
config.yaml + termination.yaml
             │
             ▼
  TypeScript Config Compiler
             │
             ▼
        Validator
             │
             ▼
 Symbol Resolution / Lowering
             │
             ▼
          JSON IR
             │
             │ --ir path
             ▼
      C++ Child Process
             │
             ▼
       IR Deserialize
             │
             ▼
      RuntimeProgram
       immutable arena
             │
             ▼
       Work Splitter
      /      |       \
     ▼       ▼        ▼
 Thread 0 Thread 1 Thread N
     │       │        │
     ▼       ▼        ▼
 Result 0 Result 1 Result N
      \      |       /
             ▼
 Deterministic Reduce
             │
             ▼
         result.gsr
             │
             ▼
    JSONL completed event
             │
             ▼
       Electron Main

         result.gsr
             │
             ▼
     C++ GSR Analyzer
             │
             ▼
       analysis JSON
             │
             ▼
 TypeScript Result Adapter
             │
             ▼
   in-memory VisualizeInput
             │
             ▼
 Electron display / material export
```

------

# 27. 实施计划

实现顺序、阶段验收和迁移门禁统一维护在 [C++ Backend Implementation Plan](<cpp-backend-plan.md>)。本文只维护设计决策，不再复制实施步骤。
