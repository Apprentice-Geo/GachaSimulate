# Development Checks

命令默认从仓库根目录的 WSL2/Linux bash 执行。只使用 WSL 内的 Node/pnpm、Clang、CMake、Ninja 和 `node_modules`。

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
build/native/bin/gachasimulate-core --ir "$ir" --target-total-draw 100 --seed 0 --threads 1 --output "$smoke_dir/target.gsr"
build/native/bin/gachasimulate-analyze --input "$smoke_dir/fixed.gsr" --metric draw
```

## Node/Electron 完整检查

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:compiler
pnpm run test:cli
pnpm run test:simulation
pnpm run test:visualize:cdf
pnpm run build
pnpm run build:web
pnpm run test:e2e
```

## 按影响范围选择

- YAML 或 IR：Compiler 测试、C++ Debug/Release CTest、typecheck。
- C++ Runtime、GSR 或 Analysis：format/tidy、Debug/Release CTest、Release install 和冒烟。
- Electron IPC、配置扫描、模拟/分析进程生命周期或 sidecar：`test:simulation`、typecheck、lint、build。
- 可视化输入、CDF、marker、动画或导出：`test:visualize:cdf`、build:web、e2e；导出改动另跑代表性 export。
- TypeScript CLI：Compiler、CLI、typecheck 和 core/analyzer 冒烟。
- 仅文档：检查命令、链接和完成状态；跨层状态文档仍按对应范围验证。

## Electron 人工验收

- 固定次数与累计抽数都能运行，threads 边界正确，任务互斥。
- 取消、窗口关闭和应用退出后无残留 core/analyzer，临时 IR 已清理。
- 完成后能打开结果目录并选择 GSR。
- draw/cost 切换正确；无 cost、损坏/超限 GSR 和 analyzer 失败显示上下文错误。
- 五字段失焦后原子保存对应 sidecar；重新打开只恢复五字段。
- 非法 sidecar 不被自动覆盖；表单和 metric 控件可用键盘操作。

格式失败时执行 `pnpm run format`；其它失败按首个具体错误修复，不用批量改动掩盖问题。
