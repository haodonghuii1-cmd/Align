# Figma Componentize Skill

将 Figma 设计稿中的重复图层识别为可复用组件，复用已有本地组件或从源图层提取正式组件，并把实例替换回原位置。

## 内容

- `SKILL.md`：Codex Skill 入口与工作流
- `references/bridge.md`：本机桥接协议和使用说明
- `scripts/bridge.py`：仅监听本机回环地址的桥接服务
- `scripts/client.py`：命令行客户端
- `assets/figma-plugin/`：Figma 开发插件

## 使用

1. 将本目录安装到 Codex 的 skills 目录。
2. 启动本机桥接服务：

   ```sh
   python3 scripts/bridge.py
   ```

3. 在 Figma 中通过 **Plugins → Development → Import plugin from manifest** 导入 `assets/figma-plugin/manifest.json`。
4. 运行插件并保持打开，然后在 Codex 中调用 `$figma-componentize`。

桥接令牌由服务启动时随机生成，只写入当前用户的本机配置文件，不包含在此仓库中，也不是 Figma 账号令牌。服务只接受本机回环连接。

## 安全边界

本仓库不包含 Figma 文件内容、个人路径、访问令牌或 API 密钥。插件只处理当前连接的 Figma 文件；执行前会校验扫描快照，失败项保留原图层。

## 验证

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
node assets/figma-plugin/tests/skill-engine.cjs
```
