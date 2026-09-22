## `feat/UI-upgrade` 前端解耦修改计划

### 目标

在**不重新设计 Workbench UI、不主动改变现有视觉效果**的前提下：

* 分离 Workbench 与 Visualization 的样式和组件边界。
* 清理依赖 DOM 结构和 CSS 覆盖的实现。
* 为后续 Workbench 独立 redesign 建立稳定基础。
* 保留当前 CDF、导出画面和布局行为。

## 1. 分离全局 CSS

**问题**

`src/renderer/main.tsx` 当前直接导入：

* `visualize/styles/tokens.css`
* `visualize/styles/preview.css`
* `visualize/styles/scene.css`

其中 Visualization CSS 包含 `body`、`#root`、表单控件、`*` 等全局规则，Workbench 实际依赖 Visualization 样式。

**修改**

* 新增 `src/styles/foundation.css`。
* 将真正全局且与视觉风格无关的规则移动到其中：

  * `@font-face`
  * `box-sizing`
  * 基础 margin/reset
  * 必要的字体继承
* 建立明确的 Visualization 样式入口，由桌面 Renderer 和 Export Renderer 按宿主需要加载。
* 桌面 Renderer 同时承载 ResultEditor CDF Preview 和正式可视化页面，因此允许在入口加载带作用域的 Visualization CSS；隔离依赖明确的 style scope，不依赖 CSS import 位于哪个组件。
* Export Renderer 继续加载同一套 Visualization token 和画面样式。

**意图**

让 Workbench 不依赖 Visualization CSS，后续修改任一侧不会污染另一侧。

---

## 2. 拆分 Design Token

**问题**

Workbench 当前直接使用：

* `--color-nvidia-green`
* `--color-cyan`
* `--color-panel`
* `--color-canvas`
* Visualization 字体、颜色和圆角 token

导致视觉风格与 NVIDIA/Sentry 参考绑定。

**修改**

拆成三层：

```text
foundation.css
renderer/tokens.css
visualize/styles/tokens.css
```

Workbench 定义自己的语义 token，例如：

```text
--workbench-bg
--workbench-surface
--workbench-surface-muted
--workbench-border
--workbench-text
--workbench-text-muted
--workbench-accent
--workbench-danger
```

本轮允许这些 token 暂时映射到现有颜色，避免视觉变化。

Visualization token 由统一的 `.visualize-scope` 提供，ResultEditor CDF Preview、正式可视化页面和 Export Renderer 从同一作用域继承，不分别维护颜色、字体、线宽、marker 或画布规格。Export Renderer 的根宿主直接带有 Visualization scope；宿主尺寸和 overflow 规则不反向依赖 React 子树中的变量。

**意图**

以后更换 Workbench 风格只修改 Workbench token，不影响 CDF 和导出素材。

---

## 3. 限定 NVIDIA / Sentry Design Reference 的作用域

**问题**

`UI_DESIGN.md` 当前仍规定：

> 桌面与导出共享视觉语言

两个 DESIGN 文档仍然被描述为整个项目的视觉参考。

**修改**

调整 `UI_DESIGN.md`：

* NVIDIA/Sentry reference 仅适用于：

  * Result Visualization
  * CDF
  * Statistics
  * Termination
  * Export Frame
* Workbench 不受两个 DESIGN 文档视觉规则约束。
* 明确 ResultEditor CDF Preview、Result Visualization 和 Export Frame 共用同一套 Visualization 视觉设计；Workbench 的导航、表单、配置仓库和编辑器外壳不受该视觉参考约束。
* 保留现有通用规则：

  * 布局
  * scroll owner
  * accessibility
  * 状态反馈
  * 最小窗口
  * 导出一致性
* 删除“桌面与导出共享视觉语言”等耦合表述。

**意图**

防止后续 Codex 根据文档再次把 Workbench 改回 Visualization 风格。

---

## 4. 给 Visualization 建立明确 Style Scope

**问题**

Visualization CSS 中存在大量全局 selector。

例如：

```css
body
#root
button
input
select
textarea
*
```

**修改**

* Visualization token 和视觉规则统一约束在 `.visualize-scope` 下；`.visualize-page` 只表示完整结果画布，不作为所有共享 CDF 样式的唯一祖先。
* `VisualizeApp`、ResultEditor 的 CDF Preview、Export Renderer 使用相同 Visualization scope、同一个 `CDFChart` 和同一份 CDF 视觉规则。
* Preview 只负责按宿主可用空间等比例缩小共享 CDF 设计坐标，不提供独立的颜色、字体、刻度、marker 或 compact 样式。
* 正式可视化页面与 Export Renderer 复用同一个 `VisualizeScene`；二者只在宿主缩放、固定尺寸、overflow 和交互控件上存在差异。
* Export Renderer 的根节点直接建立 Visualization scope，并由 export host 负责 3840×2160 尺寸与无滚动约束，避免外层 `body` 读取只能从内层 scope 获得的 token。
* 全局 CSS 只保留 foundation 中真正需要全局生效的内容。
* Workbench CSS 同样不得通过裸元素或通用组件 selector 命中 Visualization 子树；除 foundation reset 外，Workbench 页面和 primitive 使用明确的 Workbench class。

**意图**

把 Visualization 变成可嵌入 Workbench 的独立 UI Island。

---

## 5. 清理 Renderer 的 CSS Cascade 补丁

**问题**

宽泛 selector 导致后续反向覆盖：

```css
.simulation-selection label { display: grid; }
```

然后：

```css
.item-search { display: flex !important; }
.simulation-item { display: block !important; }
```

类似问题还存在于 `.panel-heading > span` 和 `.status-badge`。

**修改**

改为明确 class：

```text
.field
.search-field
.simulation-item
.panel-status
```

避免通过 HTML 标签统一设置结构。

删除非必要 `!important`。

**验收目标**

Renderer 中除 reduced-motion 等特殊规则外，不使用 `!important`。

**意图**

停止形成“规则 → 覆盖 → 再覆盖”的 CSS 补丁链。

---

## 6. 建立最小 Workbench Primitive

**问题**

Button、Header、Panel 等样式由所在页面决定。

例如：

```css
.simulation-actions button,
.repository-header button,
.repository-source-heading button,
...
```

以及：

```css
.simulation-actions button:last-child
```

决定 secondary 样式。

**修改**

只建立当前有明确重复结构、样式或行为的 primitive。

```text
Button
Field
```

Button 至少提供：

```text
primary
secondary
ghost
danger
```

使用显式 variant/class，不通过父容器和 `:last-child` 判断。

`PageHeader`、`Panel`、`PanelHeader` 先使用明确的语义 class；仅当迁移时能够消除真实重复 DOM、行为或可访问性实现，才抽取为 React 组件，不把完成组件清单作为本轮目标。

**意图**

组件外观由自身语义决定，而不是 DOM 位置决定。

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
| 1  | `foundation.css`、CSS 加载边界、双方 token 分离与 Visualization scope；作为一个可验证步骤完成三宿主接入 |
| 2  | 修改 `UI_DESIGN.md` 作用域与三宿主共享视觉约束                                                  |
| 3  | 清理 Workbench `!important`、宽泛 selector 和对 Visualization 子树的反向污染                      |
| 4  | 建立 Button / Field；按真实重复决定其它 primitive                                               |
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
