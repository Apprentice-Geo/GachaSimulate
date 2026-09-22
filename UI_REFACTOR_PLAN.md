## `feat/UI-upgrade` 前端解耦修改计划

### 目标

在**不重新设计 Workbench UI、不主动改变现有视觉效果**的前提下：

* 分离 Workbench 与 Visualization 的样式和组件边界。
* 清理依赖 DOM 结构和 CSS 覆盖的实现。
* 为后续 Workbench 独立 redesign 建立稳定基础。
* 保留当前 CDF、导出画面和布局行为。

## 已完成：阶段 1、2

### 阶段 1：CSS 加载边界、双方 token 与三宿主 scope

- 新增 `src/styles/foundation.css`，集中字体资源、box-sizing、基础 reset 与控件字体继承。
- 新增 `src/renderer/tokens.css`，Workbench 改用自身语义 token，保持当前色值与尺寸；原先隐式继承的面板标题样式归入 Workbench。
- `src/visualize/styles/index.css` 为桌面和导出共用入口；共享 token 与画面规则限定在 `.visualize-scope`。交互 viewport 样式单独按宿主加载。
- 正式页面 viewport、ResultEditor ChartPreview、导出 HTML body 均建立相同 scope；继续共享 CDFChart 与适用的 VisualizeScene。预览仅负责等比缩小，字体基线由 Visualization 自己提供。
- Workbench 使用 `@scope (.workbench-host) to (.visualize-scope)` 阻止规则进入可视化子树。广泛 selector 和 `!important` 的进一步清理见已完成的阶段 3。
- 页面缩放变量改为由 viewport 持有；导出宿主继续独立负责 3840×2160 与无滚动，body 可直接读取自己的 Visualization token。

### 阶段 2：设计参考作用域

- 更新 `docs/UI_DESIGN.md`：NVIDIA/Sentry 仅约束 Visualization、CDF、Statistics、Termination、Export Frame，包括编辑器 CDF Preview。
- Workbench 导航、表单、配置仓库与编辑器外壳可独立调整视觉；保留通用布局、scroll owner、可访问性、状态反馈、最小窗口与导出一致性约束。
- 同步 `ARCHITECTURE.md` 的共享样式入口、foundation 和宿主边界。

### 本轮验收

- 保留原有四尺寸布局与交互断言，新增 CSS scope 结构检查、Workbench token 独立性、双向换色/换字体隔离、同名 class 隔离检查。
- 比较 ResultEditor Preview、正式页面与真实 Export Renderer 的 CDF 字体、颜色、线宽、marker 样式；验证导出根 scope 与固定画布无滚动。原有测试继续覆盖预览/正式图表几何和 CSS/TS 画布规格一致。
- 验收通过：`test:electron-layout` 四尺寸（1280×720、1600×900、2560×900、2560×1440）；`test:visualize:cdf` 20 项；`test:electron-export` 39 项；`test:simulation` 46 项；typecheck、lint、format:check、普通 build。
- 真实 ExportHost 集成通过：PNG/MP4、逐帧连续性、终态一致性、取消、FFmpeg/renderer 故障与退出清理；已恢复无探针生产构建。
- 已查看大小窗口编辑器与正式结果画面截图，产物位于 `tmp/ui-captures/`。Markdown 链接检查使用独立临时 Git 索引纳入新文件后通过，实际暂存区未改变。
- 未删除、放宽或跳过既有测试，无保留失败项。以上为阶段 1、2 的验收记录；后续阶段状态见下文。

---

## 已完成：阶段 3、4

### 阶段 3：清理 Workbench CSS Cascade

- 普通表单、搜索框和物品选项分别使用明确 class，移除 label 布局的反向覆盖。
- 页面标题、面板标题、面板状态、导出弹窗标题/操作区与进度文案改用语义 class；清理宽泛按钮 selector 和基于最后一个子节点的按钮配色。
- Renderer 仅在 reduced-motion 规则中保留 `!important`；继续由 Workbench scope 阻断规则进入 Visualization 子树。

### 阶段 4：最小 Workbench Primitive

- 新增 `src/renderer/components/Button.tsx` 与 `Field.tsx`；迁移模拟、结果编辑、配置仓库及桌面导出工作流中的重复按钮和字段。
- Button 提供 primary / secondary / ghost / danger，显式区分默认、紧凑和行内尺寸，保留原生属性、ref、焦点与禁用行为；既有操作沿用原有配色。
- Field 保留原生 label 与控件关联，控件通过明确 class 获取外观，保留失焦保存、数字输入及 textarea 自适应行为。
- PageHeader / Panel / PanelHeader 保留语义 class；本轮没有足以支持额外组件化的重复行为，不扩展组件清单。

### 本轮验收

- 保留全部既有四尺寸布局、scroll owner、仓库 7:3、预览几何、双向主题隔离和三宿主 CDF 一致性检查。
- 新增真实浏览器检查：除 reduced-motion 外无 important 声明；四种按钮 variant 不受页面祖先或兄弟顺序影响，禁用反馈与原生按钮类型保持有效，Field 保留 label 关联。
- 验收通过：四尺寸 `test:electron-layout`（1280×720、1600×900、2560×900、2560×1440）、`test:simulation`、`test:visualize:cdf`、`test:electron-export`、typecheck、lint、format:check、Markdown 链接和普通 build。
- 真实 ExportHost 集成通过：PNG/MP4、逐帧连续性、终态一致性、取消、FFmpeg/renderer 故障与退出清理；结束后已恢复无探针生产构建。
- 已查看大小窗口模拟/编辑器/仓库及六种导出交互状态截图，产物保存在 `tmp/ui-captures/`。
- 首轮发现的标题 class 迁移遗漏已修复；新增检查的浏览器回调序列化问题已修复。最终无保留失败项，未删除、放宽或跳过既有测试。
- 阶段 5–8 尚未执行；本轮相关检查不代表已完成阶段 8 的全量开发验收。

---

## 7. 拆分 `App.tsx`

**问题**

当前约 1040 行，同时包含：

* `SimulationPage`
* `ResultEditorPage`
* `ConfigRepositoryPage`
* `App`

页面修改范围过大。

**修改**

拆成：

```text
renderer/
├── App.tsx
├── pages/
│   ├── SimulationPage.tsx
│   ├── ResultEditorPage.tsx
│   └── ConfigRepositoryPage.tsx
```

`App.tsx` 只负责：

* 页面切换
* Result Session
* ExportWorkflow
* 顶层 Shell

不修改现有业务状态和 IPC 行为。

**意图**

降低页面间代码耦合和后续 AI 修改的上下文范围。

---

## 8. 收紧 ResultEditor → Visualization 依赖

**问题**

两类依赖混在一起：

合理：

```text
ResultEditor → ChartPreview → CDFChart
```

不必要：

```text
Workbench summary → ResultValue
```

普通 Workbench 内容因此依赖 Visualization DOM/CSS。

**修改**

保留：

* `ChartPreview`
* `CDFChart`
* CDF view model

移除普通 Workbench UI 对 Visualization presentation component 的依赖。

例如 ResultEditor summary 自己格式化 value/unit，或抽取纯共享数据格式化函数。

**意图**

只让“可视化预览”跨越 Workbench / Visualization 边界。

---

## 9. 补齐 Workbench 基础尺寸 Token

**问题**

`styles.css` 中存在大量：

```text
desktop-unit * 7
desktop-unit * 9
desktop-unit * 13
desktop-unit * 14
...
```

目前约 44 种不同尺寸值。

**修改**

本轮不机械替换全部尺寸。

先建立常用语义：

```text
--space-xs
--space-sm
--space-md
--space-lg
--control-height
--font-caption
--font-body
--font-heading
```

仅替换明显重复的规格。

保留特殊布局尺寸，例如 CDF 画布、Sidebar 几何约束等。

**意图**

限制后续继续产生任意尺寸，不为了“统一”制造大规模无意义 diff。

---

## 10. 保留并强化现有布局测试

**问题**

本轮会修改大量 CSS 边界，容易产生无视觉意图的布局回归。

**修改**

保留 `feat/UI-upgrade` 已增强的 `electron_layout.test.ts`。

重构过程中确保继续验证：

* 1280×720 / 1600×900 / 2560×900 / 2560×1440
* scroll owner
* 页面不产生外层滚动
* Repository 7:3
* ResultEditor 布局
* CDF Preview 与正式 CDF 几何一致
* Export 行为

新增一项结构性检查：

* Visualization CSS 的非 foundation 规则全部受 `.visualize-scope` 约束。
* ResultEditor CDF Preview、正式可视化页面和 Export Renderer 都建立相同的 Visualization scope，并继续共享 `CDFChart`、`VisualizeScene` 适用部分及 CDF 视觉规则。
* Workbench CSS 不再引用 Visualization presentation token，也不通过裸元素或通用组件 selector 影响 Visualization 子树。
* Visualization token 中的画布几何契约继续与 TS 常量一致。

测试与验收决策：

* 当前测试主要保护当前 UI 效果、布局和交互行为。测试失败时，先确认失败断言实际保护的行为，再判断该行为是否属于仍需保留的设计约束。
* 若测试保护的行为合理，应修复实现并保持测试通过。
* 若测试保护的行为不合理、与本计划确认的新边界冲突，或把偶然的 CSS/DOM 实现当作契约，允许保留该项测试失败，不为得到绿色结果而修改实现；最终必须逐项汇报失败原因、该测试为何不合理，以及建议采用的合理行为和后续测试调整方案。
* 未经授权，不修改、删除、放宽或跳过与本轮重构无关的测试；不得通过缩减窗口尺寸、fixture、断言范围或提高容差规避回归。
* 结构检查保护模块与样式边界；截图和布局测试保护用户可见效果。不能用“import 已移动”代替实际的双向隔离和三宿主一致性验证。

**意图**

允许内部大幅重构，同时保持当前行为和布局稳定。

---

## 建议执行顺序

| 阶段 | 修改                                        |
| -- | ----------------------------------------- |
| 1（已完成） | `foundation.css`、CSS 加载边界、双方 token 分离与 Visualization scope；作为一个可验证步骤完成三宿主接入 |
| 2（已完成） | 修改 `UI_DESIGN.md` 作用域与三宿主共享视觉约束                                                  |
| 3（已完成） | 清理 Workbench `!important`、宽泛 selector 和对 Visualization 子树的反向污染                      |
| 4（已完成） | 建立 Button / Field；按真实重复决定其它 primitive                                               |
| 5  | 拆分 `App.tsx`                                                                                |
| 6  | 清理 ResultEditor 非预览内容的跨层依赖                                                            |
| 7  | 补基础 spacing / typography token                                                              |
| 8  | 全量布局、可视化、导出、单测和构建验证，并按测试与验收决策处理失败                                      |

## 本轮明确不做

* 不确定新的 Workbench 视觉风格。
* 不重新配色。
* 不重做页面布局。
* 不修改 CDF 视觉设计。
* 不为了组件化而建立完整组件库。
* 不机械统一所有 CSS 数值。

**完成标准：Workbench 与 Visualization 可以独立更换视觉风格，而无需通过 CSS override 保护另一侧；ResultEditor CDF Preview、正式可视化页面和 Export Renderer 仍由同一套组件、设计坐标、token 和画面样式保证视觉一致。**

## 维护者决策

- 每轮开发完成上述执行顺序的两个阶段，并在完成后更新本文档，压缩已完成任务，保留修改大纲并简洁描述执行的改动
- 每轮开发完成后，根据目标 10 的 “测试与验收决策” 做本轮改动相关的验收
