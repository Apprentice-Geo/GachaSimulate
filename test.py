from typing import List, Tuple, Dict, Any
import numpy as np
import json
import sys

def build_drops_cdf(drops: List[Dict[str, Any]]) -> Tuple[List[str], np.ndarray, np.ndarray]:
    """
    输入: drops 配置（和 JSON 中一致的列表）
    输出: (ids, probs_normalized, cdf) 
      - ids: Dict[str,Int]
      - probs_normalized: np.ndarray, 和为1
      - cdf: np.ndarray, 累计概率，用于 np.searchsorted
    验证: 检查 id 存在、概率非负且总和 > 0
    """
    ids: List[Tuple[str,int]] = []
    probs: List[float] = []
    for i, d in enumerate(drops):
        if 'id' not in d:
            raise ValueError(f"drops[{i}] missing 'id'")
        p = float(d.get('probability', 0.0))
        if p < 0:
            raise ValueError(f"negative probability for id '{d['id']}'")
        ids.append((d['id'], d['amount']))
        probs.append(p)

    probs_arr = np.array(probs, dtype=float)
    total = probs_arr.sum()
    if total <= 0:
        raise ValueError("total drop probability must be > 0")
    probs_norm = probs_arr / total # 归一化
    cdf = np.cumsum(probs_norm)
    return ids, probs_norm, cdf

if __name__ == "__main__":
    
    path = "configs/wushuang26_1_1to26_2_23.json"
    with open(path, 'r', encoding='utf-8') as f:
        raw = json.load(f)
    drops = raw.get("drops", [])
    ids, probs, cdf = build_drops_cdf(drops)
    for i, (item_id, amount) in enumerate(ids):
        print(f"{i:02d}: id={item_id}, amount={amount}, prob={probs[i]:.8f}, cdf={cdf[i]:.8f}")
    print("probs:", np.array2string(probs, formatter={'float_kind':lambda x: f"{x:.8f}"}))
    print("cdf:  ", np.array2string(cdf,  formatter={'float_kind':lambda x: f"{x:.8f}"}))
    