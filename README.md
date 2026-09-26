# Align

**Scan the real Figma layers. Extract the reusable structure. Keep the source design editable.**

Align 是一个面向 Codex 的 Figma 设计稿组件化 Skill：它通过随附的原生 Figma 插件读取真实图层，由 AI 归纳可复用的按钮、卡片、导航和其他组件族，再由插件完成确定性校验、组件提取、实例替换和变更报告。

它处理的是 Figma 中真实存在的节点，输出仍然是可编辑的 Figma 组件和实例。它不会把截图当成设计稿，也不会通过 Figma REST API 假装写入画布。

## 适合解决什么问题

- 一页设计稿里有许多重复但尚未组件化的按钮、卡片、导航项或表单控件。
- 已经存在设计系统组件，希望把普通图层映射为对应的本地组件实例。
- 希望先扫描和评估，再由 AI 给出组件族计划，最后一次性执行替换并获得逐项报告。
- 希望把新提取的组件持续追加到同一个 `Skill Components` 页面，避免每次运行产生新页面。

## AI Agent Skill

仓库根目录的 `SKILL.md` 是 Skill 入口，按需引用桥接协议和插件资源：

| 文件 | 作用 |
|---|---|
| `SKILL.md` | AI 的扫描、规划、执行和验证工作流 |
| `references/bridge.md` | 本机桥接服务、命令格式和分页协议 |
| `scripts/bridge.py` | 只监听本机回环地址的认证桥接 |
| `scripts/client.py` | 调用 `ping`、`scan`、`apply`、`verify` 的 CLI 客户端 |
| `assets/figma-plugin/` | Figma Plugin API 插件、UI 和模拟测试 |

安装后，在涉及 Figma 设计稿组件化的任务中使用 `$figma-componentize`。

## 安装

将仓库复制到 Codex 的 skills 目录：

```bash
mkdir -p ~/.codex/skills
cp -R /path/to/Align ~/.codex/skills/figma-componentize
```

启动本机桥接：

```bash
python3 ~/.codex/skills/figma-componentize/scripts/bridge.py
```

在 Figma Desktop 中选择 **Plugins → Development → Import plugin from manifest**，导入：

```text
~/.codex/skills/figma-componentize/assets/figma-plugin/manifest.json
```

运行 Align 插件并保持打开，然后在 Codex 中使用 `$figma-componentize`。插件会优先自动从本机桥接获取连接配置；只有自动连接失败时，才需要使用「替换连接令牌」入口。

## 最短工作流

```text
打开 Figma 文件
  → 运行 Align 插件并连接本机桥接
  → 扫描选区或当前页面
  → AI 读取真实节点与本地组件分页
  → 归纳组件族 / 复用现有组件
  → 用户要求执行后 apply
  → verify 校验实例、组件关联和原节点移除
  → 输出变更报告
```

默认只扫描当前选区。没有选区时不会悄悄扩大到整页；只有用户明确要求扫描当前页面时才使用 page 范围。

## 里面有什么

| 域 | 能力 |
|---|---|
| **扫描** | 读取当前选区或当前页的真实节点、层级路径、尺寸、文字、布局、跳过原因和节点快照 |
| **匹配** | 分析名称、结构、样式和布局，按组件族归纳重复模式；兼容已有本地组件分页读取 |
| **提取** | 从源图层创建正式组件，使用清晰的组件名和提取理由 |
| **替换** | 创建正式组件实例，保留文本、尺寸、相对位置和可支持的布局属性，再移除原图层 |
| **组件页** | 优先复用 `Skill Components` 或历史 `Skill Components · scan-*` 页面，新组件追加并自动排布 |
| **报告** | 返回新建组件、复用组件、成功项、失败项、跳过项和验证结果 |
| **安全** | 校验扫描快照、拒绝祖先/后代冲突、保护锁定图层，并检测指向源节点的原型连线 |

## 设计和执行原则

1. **先读真实图层，再做组件计划。** 名称相似不代表结构兼容；AI 只根据插件返回的节点数据规划。
2. **组件族必须完整兼容。** 结构、层级和样式不一致的状态拆成不同组件，不能为了减少数量强行合并。
3. **用户要求执行才写入。** 只要求扫描或分析时，流程停在报告，不自动修改 Figma 文件。
4. **先创建实例，再移除原图层。** 文本、字体、尺寸和布局检查完成后才替换，单项失败会保留原图层。
5. **组件页面保持稳定。** 新组件追加到已有组件页面，不再为每次运行创建 `Skill Backup` 页面或备份克隆；恢复优先使用 Figma 撤销。
6. **报告必须诚实。** 模拟测试和桥接连通不等于真实 Figma 写入成功，报告会区分实际执行和未执行。

## 连接令牌和隐私

桥接服务启动时随机生成本机令牌，并写入当前用户的本机配置文件。令牌不是 Figma 账号密钥，不会写入 Skill、版本库、报告或远程服务。桥接只监听 `127.0.0.1`，不会把 Figma 文件内容上传到本仓库。

## 当前边界

- 需要 Figma Desktop 中实际运行开发插件；Skill 不能凭空启动未运行的插件。
- 组件来源以当前文件内的本地组件为主；跨文件发布、团队库自动发布和完整 ComponentSet 变体矩阵不在当前版本范围内。
- 复杂富文本、受保护图层、复杂自动布局和原型交互连线以插件的安全检查结果为准。
- 新组件保留源设计的结构和外观，自动重新设计一套视觉系统属于另一项工作。

## 验证

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
node assets/figma-plugin/tests/skill-engine.cjs
node --check assets/figma-plugin/code.js
```

## License

MIT.
