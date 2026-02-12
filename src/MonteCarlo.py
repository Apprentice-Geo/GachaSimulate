import numpy as np
from .models.RuntimeDef import runtime_context

class runtime_state:
    __slots__ = (
        "inventory",          # 规则用库存（会被分解）
        "lifetime_acquired",  # 统计用累计获得
        "roll_count",
        "RMB_cost",
        "terminated"
    )

    def __init__(self, item_count: int):
        self.inventory = np.zeros(item_count, dtype=np.int32)
        self.lifetime_acquired = np.zeros(item_count, dtype=np.int32)
        self.roll_count = 0
        self.RMB_cost = 0
        self.terminated = False


class montecarlo:

    def __init__(self, ctx: runtime_context, seed=None):
        self.ctx = ctx
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        self.main_pool = ctx.pool_list[ctx.pool_id_index["main_pool"]]
        self.protected_items = self._collect_termination_items(ctx.Termination_tree)

    
    def _collect_termination_items(self, node):
        items = set()

        def dfs(n):
            if n.__class__.__name__ == "check_node":
                items.add(n.index)
            for c in getattr(n, "children", []):
                dfs(c)

        dfs(node)
        return items


    def run_once(self) -> runtime_state:
        state = runtime_state(len(self.ctx.item_list))

        while not state.terminated:
            self._one_roll_cycle(state)

        return state
    
    def _one_roll_cycle(self, state: runtime_state):

        # ① 主池
        state.roll_count += 1
        state.RMB_cost += self.ctx.RMB_per_roll
        self._execute_pool(self.main_pool, state)

        # ⑥ milestone
        self._milestone_phase(state)

        # ③ 终止判断（目标类保护）
        if self._check_termination(state):
            return

        # ④ resolve阶段
        self._resolve_phase(state)

        # ⑤ 终止判断（货币路径）
        self._check_termination(state)

    def _execute_pool(self, pool, state):
        r = self.rng.random()
        idx = np.searchsorted(pool.cdf, r)
        op = pool.ops[idx]
        self._apply_op(op, state)

    def _apply_op(self, op, state, count_lifetime=True):
        t = op.__class__.__name__

        if t == "add_item":
            self._add_item(op.index, op.amount, state, count_lifetime)

        elif t == "reduce_item":
            state.inventory[op.index] -= op.amount

    def _add_item(self, idx, amount, state, count_lifetime=True):
        
        item_def = self.ctx.item_list[idx]
        if item_def.trigger is not None:
            pool = self.ctx.pool_list[item_def.trigger]
            self._execute_pool(pool, state)
        else:
            state.inventory[idx] += amount

            if count_lifetime:
                state.lifetime_acquired[idx] += amount

            



    def _resolve_phase(self, state):

        for idx, item_def in enumerate(self.ctx.item_list):

            if idx in self.protected_items:
                continue

            if item_def.resolve is None:
                continue

            count = state.inventory[idx]
            if count <= 0:
                continue

            res = self.ctx.resolve_list[item_def.resolve]
           
            for _ in range(count):
                for op in res.ops:
                    
                    self._apply_op(op, state, count_lifetime=False)


    def _milestone_phase(self, state):
        for ms in self.ctx.milestone_list:
            if state.roll_count == ms.roll_count:
                for op in ms.ops:
                    self._apply_op(op, state)

    def _check_termination(self, state):
        if self._eval_logic(self.ctx.Termination_tree, state):
            state.terminated = True
            return True
        return False
    
    def _eval_logic(self, node, state):

        if node.op == "OR":
            return any(self._eval_logic(c, state) for c in node.children)

        if node.op == "AND":
            return all(self._eval_logic(c, state) for c in node.children)

        if node.__class__.__name__ == "check_node":
            val = state.inventory[node.index]
            if node.op == ">=":
                return val >= node.value
            if node.op == ">":
                return val > node.value
            if node.op == "==":
                return val == node.value
            








