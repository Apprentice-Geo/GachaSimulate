import json
import numpy as np
from math import isclose
from typing import List, Tuple, Dict, Any
from collections import namedtuple
from src.models.ItemDef import Item, ItemBehavior,Resolve
from src.models.DropDef import Drop
from src.models.MilestoneDef import Milestone, Reward
from src.models.TerminationDef import LogicNode, CheckNode

class config_parser:
    def __init__(self, config_path):
        with open(config_path, 'r', encoding='utf-8') as f:
            self.config = json.load(f)
        self.Config_name=self.config.get("meta",{}).get("name","")
        self.Items_dict: Dict[str, Item] = {}
        self.DropPools: Dict[str,List[Drop]] = {}
        self.ItemBehaviors_dict: Dict[str, ItemBehavior] = {}
        self.Rules_dict: Dict[str, Any] = {}
        self.Milestones_dict:Dict[str,Milestone]={}
        self.Termination_tree:LogicNode

        self._get_items()
        self._get_trigger_rules(self.config.get("trigger_rules",{}))
        self._get_milestones(self.config.get("milestones",{}))
        self._get_drops(self.config.get("drops",{}))
        self._get_termination_tree(self.config.get("termination_conditions",{}))

    def _get_items(self):
        items = self.config.get("items", {})
        for id, item in items.items():
            if not isinstance(item, dict):
                raise TypeError(f"item '{id}' must be an object")
            name = item.get("name", "")
            trigger_rule = item.get("trigger_rule", None)
            self.Rules_dict[trigger_rule]=None
            rr = item.get("resolve_result", None)
            if rr is None:
                resolve_result = None
            else:
                if not isinstance(rr, dict):
                    raise TypeError(f"resolve_result for '{id}' must be an object")
                resolve_result = Resolve(
                    type=rr.get("type", ""),
                    id=rr.get("id", ""),
                    amount=int(rr.get("amount", 1))
                )
            self.ItemBehaviors_dict[id] = ItemBehavior(
                trigger_rule=trigger_rule,
                resolve_result=resolve_result
            )
            self.Items_dict[id] = Item(id=id, name=name, behavior=self.ItemBehaviors_dict[id])


    
    def _get_drops(self,drops):
        pool_name= drops.get("name","")
        self.DropPools[pool_name]=[]
        for i, d in enumerate(drops.get("entries", [])):
            if 'id' not in d:
                raise ValueError(f"drops[{i}] missing 'id'")
            p = float(d.get('probability', 0.0))
            self.DropPools[pool_name].append(Drop(
                prob=p,
                type=d.get('type', ''),
                id=d.get('id', ''),
                amount=int(d.get('amount', 1))
            ))
            
    
    def _get_trigger_rules(self,trigger_rules):
        
        for rule_id,rule in trigger_rules.items():
            if rule['type']=="sub_pool":
                self.Rules_dict[rule_id]="sub_pool"
                self._get_drops(rule.get("drops",{}))
            else:
                pass

    
    def _get_milestones(self,milestones):
        
        for milestone_id,milestone in milestones.items():
            reward_config=milestone.get("reward",{})
            reward=Reward(type=reward_config.get("type",""),
                          id=reward_config.get("id",""),
                          amount=int(reward_config.get("amount",1))
                          )
            self.Milestones_dict[milestone_id]=Milestone(type=milestone.get("type",""),
                                                   roll_count=int(milestone.get("roll_count",0)),
                                                   reward=reward
                                                   )
    
    def _get_termination_node(self,condition):
        if condition["type"] == "logic":
            return LogicNode(
                op=condition.get("op", "OR"),
                children=tuple(self._get_termination_node(cond) for cond in condition.get("children", []))
            )

        elif condition["type"] == "predicate":
            return CheckNode(
                subject=condition["subject"],
                id=condition["id"],
                op=condition["op"],
                value=condition["value"]
            )
    
    def _get_termination_tree(self,termination_conditions):
        self.Termination_tree=LogicNode(op="OR",children=tuple(
            self._get_termination_node(c) for c in termination_conditions)
        )
        
        
    