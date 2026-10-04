# 讲解文档

这套文档解释 dsh-computer-control **是什么、怎么工作、怎么用、出问题怎么办**。建议按顺序读。

| 文档 | 内容 | 适合谁 |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构与实现原理：插件怎么被 DSH 加载、工具怎么注册、平台适配层怎么分层、两个原生助手做了什么、消息为什么两段式、截图怎么贴进对话 | 想搞懂原理 / 想改代码 |
| [TOOLS.md](TOOLS.md) | 9 个工具的完整参考：参数、返回值、示例、跨平台差异、常见组合套路 | 日常使用者 / 写提示词 |
| [PLATFORMS.md](PLATFORMS.md) | macOS 与 Windows 的逐项对照：实现机制、安装步骤、权限、能力矩阵、各自的坑 | 两个平台都要用的人 |
| [SAFETY.md](SAFETY.md) | 安全设计：购物守卫拦什么、为什么这样设计、agent 为什么无法自己放权、风险边界 | 关心安全的人 |
| [USAGE.md](USAGE.md) | 使用教程：从零开始的实操场景（看屏幕、点按钮、发消息、逛电商、填表、批量操作） | 第一次用 |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 故障排查手册：症状 → 原因 → 解决 | 卡住的时候 |

## 30 秒版本

```
用户/模型
   │  调用 computer_* 工具（9 个）
   ▼
DSH 工具注册表（ctx.tools.register）
   │
   ▼
lib/tools.js ── 参数校验 / 购物守卫 / 结果渲染 / 贴图
   │
   ▼
lib/platform/<平台>.js ── 唯一的 OS 相关层
   ├─ darwin：bin/dsh-input（Swift + CoreGraphics）＋ osascript
   └─ win32 ：bin/dsh-input.exe（C# + SendInput/GDI+）＋ PowerShell
```

一句话：**工具层跨平台，平台层各写一份，购物守卫夹在中间。**

## 相关文件

- 项目主页与安装说明：[../README.md](../README.md)（英文版 [../README.en.md](../README.en.md)）
- 自检脚本：`node scripts/selftest.mjs`
- 配置示例：`~/.dsh/computer-control/config.json`（首次挂载自动生成）
