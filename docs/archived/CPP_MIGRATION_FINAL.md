# C++ 后端迁移收尾报告

> 归档日期：2026-08-11。本文记录第五阶段删除门槛与最终边界。

## 结论

TS Compiler 已成为唯一 YAML 编译实现，C++ Runtime 已成为唯一模拟执行权威。Electron main 直接生成临时 IR、调用受信任的 core/analyzer，并以 GSR 作为唯一模拟结果。

旧实现删除前，Python 全量测试共 95 项通过；随后 C++ Release CTest 共 9 项通过并重新安装原生产物。确定性语义由共享 IR/GSR fixture 与 Runtime/CLI 行为测试覆盖；随机配置只校验统计规则、终止与批量不变量，不要求跨实现相同 seed 逐样本一致。

代表性完整链路的环境、规模、并行度、耗时与内存结果已经固定在 [C++ / Python 模拟—统计链路性能基线](CPP_PYTHON_PERFORMANCE_BASELINE.md)。该报告表明切换具有明确性能和内存收益，不在删除阶段重复维护双实现 benchmark。

## 删除范围

- Python Runtime、CLI、NPZ 与旧 sidecar 生成实现。
- Python 单元测试与 benchmark 驱动。
- `pyproject.toml`、uv lockfile、Python 工具配置和依赖。
- Electron、README 与开发检查中的 Python/uv 当前入口。

语言无关 YAML/IR/GSR fixture、C++ benchmark case、TS Compiler 测试、C++ 测试和归档性能报告继续保留。历史实现从 Git 提交 `71afa7d` 或更早版本获取，不建立长期兼容层。

## 最终产品边界

- `SimulationRequest` 使用 `threads`，不含 `workers` 或 `metric`，未知字段在 main 被拒绝。
- main 只从 `build/native/bin` 启动原生程序，只在 `<userData>/results/` 生成 GSR 输出路径。
- Electron 结果页重新分析 GSR，只允许编辑五个展示字段，并原子保存按 metric 区分的完整 sidecar。
- 非法 sidecar、无 cost section、analyzer 非零退出和超限 JSON 都作为上下文错误返回，不自动覆盖现有文件。

## 后置项

远端配置仓库、应用安装包、分析详情、CDF 同屏预览、sidecar 历史和 GSR 内嵌展示元数据不在本阶段实现。
