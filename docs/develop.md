条件树增加action节点，以期通过定义action完成pool change
相对应需要修改引擎逻辑、parser和ctx builder

关于物品附属行为，需要支持触发特定池子抽取和物品分解行为
池子是立刻触发，但是物品分解可能需要延后
可考虑在runtime设置专门的数组记录池子、分解信息，使用与item相同的index记录，对执行效率也有提升
设置resolve运行时数组

对于随抽数变化的池子，可以并入里程碑机制中，这样的话可能要考虑修改milestone为其他单词表示
roll->draw,milestone->draw stage,amount->count,命名使用下划线链接，移除-，不使用驼峰

通过为上述行为定义action，可支持多种触发条件挂载，不过对于执行或许需要设计
action:{type: }
type:
- add_item
- reduce_item
- pool_change
- draw
- termination

对于每一个type，可继承基本的action类，各自补充执行需要的信息

这样设计可使得所有物品操作都由action完成
需要预先生成引擎可使用的事件，直接供给引擎调用，从而引擎不需要构造action

如此修改以后，支持：
- 抽取直到满足指定终止树的条件
- 行为：池子切换
- 行为：物品分解
- 行为：触发池子

对于可穷举的池子数，该机制应该足够。但是对于池子数量过多的情况不支持，不过目前没见过不同概率池子数量过多的情况

先完成对wuxiang的修改

models定义parser和builder输出都数据结构
parser把DSL变为Python的数据结构
builder把parser输出变成数组存储的结构，利用随机访问的$O(1)$加快运行速度
engine使用builder给出的上下文运行

能否跳过parser呢，parser原语义应该是语法检查，但是DSL的语法自己实现，没有所谓检查
并且实际上也可以直接输出为int索引，按照物品，池子，规则，终止树的顺序编译即可
所以：删除parser