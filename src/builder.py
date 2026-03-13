from .parser import config_parser
from .models.ItemDef import *
from .models.DropDef import *
from .models.RuntimeDef import *
from .models.TerminationDef import *

class runtime_builder:
    def __init__(self, config: config_parser):
        self.config = config
        self.item_id_index:Dict[str,int]={}
        self.item_id_name:Dict[str,str]={}
        self.item_list:List[item]=[]
        self.tmp_resolve_list:List[Tuple[int,Resolve]]=[]
        self.resolve_flag:bool=False
        self.resolve_list:List[resolve]=[]
        self.pool_id_index:Dict[str,int]={}
        self.tmp_pool_list:List[str]=[]
        self.pool_list:List[pool]=[]
        self.milestone_id_index:Dict[str,int]={}
        self.milestone_list:List[milestone]=[]
        self.Termination_tree:LogicNode | None=config.Termination_tree
    
    def _build_items(self):
        for i,(id,it) in enumerate(self.config.Items_dict.items()):
            trigger_index=None
            resolve_index=None
            if it.behavior.trigger_rule is not None:
                trigger_index=len(self.tmp_pool_list)
                self.tmp_pool_list.append(it.behavior.trigger_rule)
            if it.behavior.resolve_result is not None:
                self.resolve_flag=True
                resolve_index=len(self.tmp_resolve_list)
                self.tmp_resolve_list.append((i,it.behavior.resolve_result))
            self.item_id_index[id]=i
            self.item_id_name[id]=it.name
            self.item_list.append(item(
                index=i,
                trigger=trigger_index,
                resolve=resolve_index
            ))
        self.tmp_pool_list.append("main_pool")
    
    def _build_resolves(self):
        for i, resolve_obj in self.tmp_resolve_list:
            if resolve_obj.type=="item":
                self.resolve_list.append(resolve(
                    ops=[reduce_item(index=i,amount=1),add_item(index=self.item_id_index[resolve_obj.id],amount=resolve_obj.amount)]
                ))
    
    def _build_pools(self):
        for i in self.tmp_pool_list:
            drops=self.config.DropPools.get(i,[])
            cdf=[]
            ops=[]
            cum_prob=0.0
            for d in drops:
                cum_prob+=d.prob
                cdf.append(cum_prob)
                if d.type=="item":
                    ops.append(add_item(
                        index=self.item_id_index[d.id],
                        amount=d.amount
                    ))
            cdf[-1] = 1.0
            self.pool_id_index[i]=len(self.pool_list)
            self.pool_list.append(pool(
                index=self.pool_id_index[i],
                cdf=np.array(cdf,dtype=np.float64),
                ops=ops
            ))

    def _build_milestones(self):
        for id,ms in self.config.Milestones_dict.items():
            ops=[]
            
            if ms.reward.type=="item":
                ops.append(add_item(
                    index=self.item_id_index[ms.reward.id],
                    amount=ms.reward.amount
                ))
            self.milestone_id_index[id]=len(self.milestone_list)
            self.milestone_list.append(milestone(
                roll_count=ms.roll_count,
                ops=ops,
            ))

    def _build_termination(self, node):
        if isinstance(node, LogicNode):
            return LogicNode(
                op=node.op,
                children=tuple(self._build_termination(c) for c in node.children)
            )
        elif isinstance(node, CheckNode):
            if node.subject == "item":
                return check_node(
                    index=self.item_id_index[node.id],
                    op=node.op,
                    value=node.value,
                    reason=node.reason
                )
        else:
            raise TypeError(f"Unknown termination node: {node}")
        
    def build(self):
        self._build_items()
        self._build_resolves()
        self._build_pools()
        self._build_milestones()
        if self.Termination_tree is not None:
            self.Termination_tree=self._build_termination(self.Termination_tree)
        else:
            self.Termination_tree=None
        return runtime_context(
            RMB_per_roll=self.config.RMB_per_roll,
            item_id_index=self.item_id_index,
            item_id_name=self.item_id_name,
            item_list=self.item_list,
            resolve_flag=self.resolve_flag,
            resolve_list=self.resolve_list,
            pool_id_index=self.pool_id_index,
            pool_list=self.pool_list,
            milestone_id_index=self.milestone_id_index,
            milestone_list=self.milestone_list,
            Termination_tree=self.Termination_tree
        )
        