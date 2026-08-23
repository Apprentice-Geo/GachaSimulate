# Development Checks

本文列出的标准检查命令和 CI 基准默认从仓库根目录的 WSL2/Linux bash 执行，并使用 Linux 环境内的 Node/pnpm、Clang、CMake、Ninja 和 `node_modules`。
在其它平台开发时，应独立安装对应平台的依赖、使用独立的 CMake 构建目录和原生程序，并尽可能执行对应的等价检查。

## 前置准备

```bash
pnpm install --frozen-lockfile
```

Electron 开发前必须完成 C++ Release install：

```bash
cd cpp
cmake --preset linux-release
cmake --build --preset linux-release
ctest --preset linux-release
cmake --install ../build/cpp/linux-release --prefix ../build/native
cd ..
```

## C++ 完整检查

```bash
find cpp/include cpp/src cpp/tests -type f \( -name '*.cpp' -o -name '*.hpp' \) -print0 | xargs -0 clang-format --dry-run --Werror

cd cpp
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --preset linux-debug
find src tests -name '*.cpp' -print0 | xargs -0 clang-tidy -p ../build/cpp/linux-debug
cmake --preset linux-release
cmake --build --preset linux-release
ctest --preset linux-release
cmake --install ../build/cpp/linux-release --prefix ../build/native
cd ..
```

冒烟：

```bash
smoke_dir="$(mktemp -d)"
ir="$(realpath cpp/tests/batch_fixture_ir.json)"
build/native/bin/gachasimulate-core --ir "$ir" --total-runs 10 --seed 0 --threads 1 --output "$smoke_dir/fixed.gsr"
build/native/bin/gachasimulate-analyze --input "$smoke_dir/fixed.gsr"
```

## Node/Electron 完整检查

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:packages
pnpm run test:simulation
pnpm run test:visualize:cdf
pnpm run test:electron-layout
pnpm run build
```

Package 的 `dist/` 不提交；Electron 和相关测试入口会在使用前构建所需 package。

## 按影响范围选择

- YAML：`test:packages` 中的 Compiler 测试和 typecheck；若改变 IR，继续执行 IR 对应检查。
- IR：`test:packages` 中的 Compiler 测试、`test:simulation` 中的 native pipeline、C++ Debug/Release CTest 和 typecheck。
- 配置仓库 index、manifest 或包文件清单协议：`test:config-repository-contract`、`test:packages`、`test:simulation` 中的下载/安装行为测试和 typecheck。
- C++ Runtime、GSR 或 Analysis：format/tidy、Debug/Release CTest、Release install 和冒烟。
- Electron IPC、配置扫描、模拟/分析进程生命周期或 sidecar：`test:simulation`、typecheck、lint、build。
- AnalysisV2 或 DisplayConfig 输入契约：同步核对 JSON Schema、semantic validator、TypeScript 类型和共享 fixture，并执行 `test:visualize:cdf`、`test:simulation`、typecheck 和 build。
- CDF、marker、统计展示或动画：`test:visualize:cdf`、`test:electron-layout` 和 build；导出改动另跑代表性实际 export。
- 仅文档：检查命令、链接和完成状态；跨层状态文档仍按对应范围验证。

## Electron 人工验收

UI 回归分工：`capture:ui` 只准备场景并输出截图；布局、滚动、renderer 缩放和真实 DOM/SVG 几何由 `pnpm run test:electron-layout` 独立检查。内部滚动区域必须有明确滚动所有者，panel 标题不能放入内容滚动容器；缩放按实际 CSS viewport 验证。CDF compact/default 同时检查纯几何参数与最终 DOM。结果字段只在失焦时保存，WSL2/WSLg 输入法能力不作为 renderer 输入框自动化断言。

- 固定次数能运行，threads 边界正确，任务互斥。
- 取消、窗口关闭和应用退出后无残留 core/analyzer；失败任务不留下临时 IR 或半成品 GSR。
- 完成后能打开结果目录并选择 GSR。
- 启动前选择的任意合法 result item 都能分析；损坏/超限 GSR 和 analyzer 失败显示上下文错误。
- 六个展示字段失焦后原子保存对应 DisplayConfig sidecar；重新打开只恢复展示配置，分析字段来自 GSR。
- 非法 sidecar 不被自动覆盖；结果编辑和结果可视化页面可用键盘操作并共享 GSR 选择。

格式失败时执行 `pnpm run format`；其它失败按首个具体错误修复，不用批量改动掩盖问题。
