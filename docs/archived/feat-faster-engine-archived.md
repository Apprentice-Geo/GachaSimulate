# faster-engine 性能优化执行归档

> 分支：`feat/faster-engine`，主要做 Python 层面的性能优化。

本次性能测试配置：

```python
if __name__ == "__main__":
    base_seed = int("666")
    run_save(
        "sanliou_zhenpinchuanshuo",
        "termination_skin",
        target_total_draw=1010000,
        seed=base_seed,
        workers=1
    )
```

profile 结果：

```cmd
Fri Jun 19 01:42:58 2026    profile.prof

         166321579 function calls (147555710 primitive calls) in 52.616 seconds

   Ordered by: cumulative time
   List reduced from 4454 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
    452/1    0.012    0.000   51.873   51.873 {built-in method builtins.exec}
      2/1    0.000    0.000   51.873   51.873 example.py:1(<module>)
      2/1    0.000    0.000   51.872   51.872 example.py:19(run_save)
      2/1    0.002    0.001   51.815   51.815 GachaSimulate\src\simulate\core.py:178(simulate_until_total_draw)
      2/1    0.058    0.029   51.812   51.812 GachaSimulate\src\simulate\core.py:17(_simulate_until_total_draw_serial)
    26416    0.276    0.000   51.460    0.002 GachaSimulate\src\simulate\engine.py:35(run_once)
  1010033    1.010    0.000   51.103    0.000 GachaSimulate\src\simulate\engine.py:47(_one_draw_cycle)
  1010033    2.278    0.000   37.564    0.000 GachaSimulate\src\simulate\engine.py:63(_stage_phase)
21307270/5050165   17.150    0.000   29.423    0.000 GachaSimulate\src\simulate\engine.py:126(_eval_condition)
5426592/3976755    3.207    0.000   14.031    0.000 GachaSimulate\src\simulate\engine.py:104(_execute_action)
4219963/3184993    1.336    0.000   10.521    0.000 GachaSimulate\src\simulate\engine.py:98(_execute_actions)
 37273195    5.206    0.000    8.758    0.000 {built-in method builtins.isinstance}
  2045003    2.218    0.000    5.780    0.000 GachaSimulate\src\simulate\runtime.py:92(execute)
 14749670    3.696    0.000    3.696    0.000 GachaSimulate\src\simulate\engine.py:164(_get_subject_value)
 11396843    1.919    0.000    3.551    0.000 <frozen abc>:117(__instancecheck__)
  2045004    0.800    0.000    3.360    0.000 GachaSimulate\.venv\Lib\site-packages\numpy\_core\fromnumeric.py:1421(searchsorted)
  1010033    2.455    0.000    3.146    0.000 GachaSimulate\src\simulate\engine.py:82(_resolve_phase)
 14749670    1.674    0.000    1.674    0.000 GachaSimulate\src\simulate\engine.py:174(_compare)
 11396843    1.627    0.000    1.633    0.000 {built-in method _abc._abc_instancecheck}
  2045004    1.398    0.000    1.398    0.000 {method 'searchsorted' of 'numpy.ndarray' objects}
 11925378    1.340    0.000    1.342    0.000 {method 'extend' of 'list' objects}
  2459949    1.176    0.000    1.176    0.000 GachaSimulate\src\simulate\runtime.py:64(execute)
```

优化后结果：

```cmd
Sat Jun 20 15:58:07 2026    profile.prof

         90499156 function calls (71733476 primitive calls) in 34.730 seconds

   Ordered by: cumulative time
   List reduced from 4375 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
    454/1    0.013    0.000   33.981   33.981 {built-in method builtins.exec}
      2/1    0.000    0.000   33.981   33.981 example.py:1(<module>)
      2/1    0.001    0.000   33.980   33.980 example.py:19(run_save)
      2/1    0.002    0.001   33.969   33.969 GachaSimulate\src\simulate\core.py:178(simulate_until_total_draw)
      2/1    0.060    0.030   33.967   33.967 GachaSimulate\src\simulate\core.py:17(_simulate_until_total_draw_serial)
    26416    0.262    0.000   33.685    0.001 GachaSimulate\src\simulate\engine.py:31(run_once)
  1010033    1.092    0.000   33.346    0.000 GachaSimulate\src\simulate\engine.py:43(_one_draw_cycle)
  1010033    1.693    0.000   20.933    0.000 GachaSimulate\src\simulate\engine.py:59(_stage_phase)
20297237/4040132   12.993    0.000   15.693    0.000 GachaSimulate\src\simulate\engine.py:129(_eval_condition)
6436625/4986788    2.514    0.000   10.572    0.000 GachaSimulate\src\simulate\engine.py:100(_execute_action)
4219963/3184993    1.472    0.000    8.071    0.000 GachaSimulate\src\simulate\engine.py:94(_execute_actions)
  2045003    2.333    0.000    5.870    0.000 GachaSimulate\src\simulate\runtime.py:134(execute)
  2045003    0.781    0.000    3.332    0.000 GachaSimulate\venv\Lib\site-packages\numpy\_core\fromnumeric.py:1421(searchsorted)
  1010033    2.340    0.000    3.000    0.000 GachaSimulate\src\simulate\engine.py:78(_resolve_phase)
  3469982    1.534    0.000    1.534    0.000 GachaSimulate\src\simulate\runtime.py:100(execute)
 13739637    1.404    0.000    1.404    0.000 GachaSimulate\src\simulate\engine.py:170(_compare)
  2045003    1.369    0.000    1.369    0.000 {method 'searchsorted' of 'numpy.ndarray' objects}
 11925378    1.298    0.000    1.300    0.000 {method 'extend' of 'list' objects}
```

### 核心变更

1. 移除 Action / Condition 热路径 `isinstance` 分派。Action 与 ConditionNode 引入整数 `kind` 类型标记，运行时改为按 `kind` 分派。
2. 将 `draw_count` 统一纳入 item state。`draw_count` 不再是 `RuntimeState` 的独立字段，而是普通 item，由配置显式声明和管理。
3. 拆分每抽固定行为为 `every_draw`。新增根级 `every_draw` 配置，用于承载每抽必定执行的动作，并将抽数递增逻辑迁移至该阶段。
4. 增加`RuntimeOpCode`，统一运算符为整数编码，移除原实现的运算符字符串比较。
