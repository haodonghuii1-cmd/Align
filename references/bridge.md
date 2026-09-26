# 本机插件通道

## 首次连接

桥接仅监听 `127.0.0.1:8766`，不暴露到局域网。Python 3 标准库即可运行，无需安装依赖。

```sh
python3 ~/.codex/skills/figma-componentize/scripts/client.py status
```

如果服务未运行，使用终端进程启动并保持运行（Codex 可用后台 exec 会话）：

```sh
python3 ~/.codex/skills/figma-componentize/scripts/bridge.py
```

配置写入 `~/.codex/figma-componentize-bridge.json`，权限 0600。其中 token 只用于本机桥接，不是 Figma 账号密钥。不要把 token 写进 skill、版本库、报告或远程服务。重启服务会更换 token 并清空内存任务，需要重新连接插件。

用户在 Figma 桌面版中：

1. 打开目标设计文件。
2. Plugins → Development → Import plugin from manifest，选择本 Skill 的 `assets/figma-plugin/manifest.json`。
3. 运行 Align 插件。
4. 插件会优先从本机桥接服务自动获取 token 并连接；如果自动连接失败，可在「替换连接令牌」入口手动填入配置中的 token。
5. 保持插件打开，选中要处理的画板或元素。

插件运行、连接后使用以下命令核对真实上下文：

```sh
python3 ~/.codex/skills/figma-componentize/scripts/client.py status
python3 ~/.codex/skills/figma-componentize/scripts/client.py call ping
```

## 任务调用

`client.py call <ping|scan|apply|verify> --args-file /absolute/path/args.json --request-id <unique-id> --timeout 120`

JSON 输出是任务信封，实际插件响应位于 `result` 字段；失败读取 `error`。保存完整信封，不能只摘录一个成功计数。

扫描参数（无选区时不能悄悄改为 page）：

```json
{"scope":"selection"}
```

用户明确要求扫描整个当前页时：

```json
{"scope":"page"}
```

计划基本格式（ID 必须从 scan 响应获得）：

```json
{
  "scanId": "<scan 返回值>",
  "families": [
    {"name":"Button/Primary/Default","sourceIds":["<源节点 ID>"],"reason":"相同结构的主操作按钮，可统一复用"}
  ],
  "reuse": [
    {"sourceId":"<源节点 ID>","componentId":"<现有本地组件 ID>"}
  ]
}
```

保持 apply 参数与执行器支持的字段一致。候选树过大时缩小选区；blockedReason 非空的候选不执行。组件库分页与选区大小无关，按下面的分页说明处理，不把缺失内容当作兼容。

## 不确定结果

任务超时后查询原 requestId：

```sh
python3 ~/.codex/skills/figma-componentize/scripts/client.py result <requestId>
```

服务同一时刻只接受一个待执行任务；同 requestId、同负载会返回原任务，同 ID 不同负载拒绝。已投递任务不会自动重发，避免重复修改。插件会话内也做去重，但重启后不保证延续。

断开/崩溃导致任务停在 delivered 时，先在 Figma 检查组件页及实例节点状态，保存已有报告，再决定恢复；当前执行器不会创建新的 Backup 页面或备份克隆，恢复优先使用 Figma 撤销。不要直接通过重启规避 pending 检查后重新执行原写入。

## 协议边界

Skill 只发送 `ping`、`scan`、`apply`、`verify` 这四种受限命令，桥接不执行任意 JavaScript。插件 UI 轮询任务，通过 `figma.ui` 的 `skill-command` 消息交给原生控制器，使用 `skill-result` 返回结果。只连接一个文件会话，不向所有打开的文件广播。

运行 Figma 中的开发插件与本机服务连接仍需要首次用户操作。尚未接入真实插件时，HTTP 或模拟节点测试只验证代码路径，不能声称完成真实 Figma 修改。

## 校验

把 apply 响应中 status 为 success 的 entries 原样写到 verify 参数文件：

```json
{"entries":[{"sourceId":"<原节点>","newNodeId":"<实例>","componentId":"<组件>","backupNodeId":null}]}
```

执行 `client.py call verify --args-file /absolute/path/verify.json`。结果含 entries、verified、failed，每项返回 instanceExists、componentMatches、backupExists、originalRemoved。由于 apply 不再生成备份页，正常结果中 `backupExists` 为 `false`、`backupNodeId` 为 `null`；只要实例存在、组件关联正确且原节点已移除，仍可判定为 `verified`。此检查只验证节点关系，不等同于截图视觉比对。

scan 实际返回 scanId、pageId、pageName、scope、trees、candidates、components、componentsTruncated、nodeCount。候选的 signature 是兼容性分组提示，不是 AI 置信度；blockedReason 非空的候选不可自动替换。完整相等性由执行器在 apply 再检验。

## 本地组件分页

scan 支持 `componentOffset`，默认 0；响应含 componentTotal、componentOffset、nextComponentOffset 和 componentsTruncated。若 nextComponentOffset 非 null，以相同 scope 和新的 componentOffset 继续扫描，直到读完组件库，才能判断是否存在可复用组件。返回 skipped 是跳过的受保护子树根，blockedReason 是候选的不可处理原因，两者应分别报告。

每次 scan 会使前一次 scanId 失效，只保存当前组件窗口。先完整收集所有分页用于规划；执行前重新 scan 含所需目标组件的窗口，使用该次 scanId。跨多个窗口的复用应拆成串行批次，各批先重新扫描，再应用并验证。提取新组件也使用最新 scanId。任何先前 ID 若因替换而消失，依据新扫描调整计划，不重放旧计划。

开发验证：桥接服务使用本机回环地址（`127.0.0.1`），插件通过本机服务读取和写入当前 Figma 文件。发布版本不包含任何用户文件、节点数据或连接令牌。
