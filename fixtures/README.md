# Fixtures

用于单元 / 集成 / 端到端测试的 anydocs 项目快照。

| Fixture | 来源 | 用途 |
|---|---|---|
| `starter-docs/` | `anydocs/examples/starter-docs`（2026-05-06 快照） | 最小可用的 anydocs 项目——单节、每语言单页、双语（zh + en）。用于验证结构层投影（阶段 3）和 §4.6「拖拽零 embedding 重算」端到端测试（阶段 5）。 |

这些 fixtures 是**冻结副本**——不要就地修改以追随上游 anydocs 的变化。如果 anydocs schema 演进而需要新 fixtures，请有意识地刷新并同步更新测试。
