# tests/scripts/

R&D 用的 shell / Python 脚本，不是 `bun test` 自动跑的测试。

- `drive.py` — 早期 e2e 驱动脚本（被 bun:test e2e 取代前使用）
- `manual/` — 手动跑的长对话脚本（v3 / v4 / embedded / stress / variance 等）
  - 这些是 R&D 探索阶段的脚本，与代码演进节奏有关，不是回归测试
  - 现在已移出主测试目录，避免污染 `tests/`

如果想手动跑某一个 R&D 脚本：

```bash
bash tests/scripts/manual/v3-10round-test.sh
```

要清理历史对话后跑：

```bash
rm -rf data/sessions/* data/timeline/* && bash tests/scripts/manual/v3-10round-test.sh
```
