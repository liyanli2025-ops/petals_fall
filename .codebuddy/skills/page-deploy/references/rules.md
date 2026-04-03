# 规则检测流程（预览→确认→修复）

发布前会自动运行安全检测规则，所有规则均支持 **severity 级别** 和 **预览模式**：

## Severity 级别说明

| 级别 | 标识 | 说明 | 处理建议 |
|------|------|------|---------|
| **ERROR** | 🔴 `[ERROR]` | 高风险 — 可能导致安全问题或页面完全不可用 | **强烈建议修复** |
| **WARN** | 🟡 `[WARN]` | 中风险 — 可能影响稳定性或加载性能 | **建议修复** |
| **INFO** | 🔵 `[INFO]` | 低风险 — 建议性优化 | 可选修复 |

## 规则执行流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    预览 → 确认 → 修复 流程                        │
└─────────────────────────────────────────────────────────────────┘

  Step 1              Step 2              Step 3
    ↓                   ↓                   ↓
┌──────────┐    ┌──────────────┐    ┌──────────────┐
│ --preview│    │ 展示问题列表 │    │   --fix      │
│ 预览检测 │ →  │ ERROR/WARN/  │ →  │   执行修复   │
│ 不修改   │    │ INFO 级别    │    │   修改文件   │
└──────────┘    └──────────────┘    └──────────────┘
                      ↓
               用户确认处理方式
```

- **所有规则**（第三方资源、外部字体、内网链接）：先展示问题和 severity 级别 → 暂停等待用户选择「自动修复」或「忽略」

> ⚠️ **强制约束 — 禁止 AI 自动代替用户做决策**
>
> 当规则检测到问题时（exit code = 2），无论问题级别是 🔴 ERROR、🟡 WARN 还是 🔵 INFO，AI **必须暂停并向用户展示检测结果，等待用户明确回复后才能继续**。
>
> **禁止行为**：
> - ❌ AI 自行判断风险级别后直接追加 `--fix-xxx` 或 `--skip-xxx` 参数重新运行
> - ❌ AI 替用户选择「自动修复」或「忽略」
> - ❌ 以"都是 WARN/INFO 级别，风险不高"为由跳过用户确认
>
> **正确行为**：
> - ✅ 展示检测到的问题列表（含 severity 级别、URL、风险说明）
> - ✅ 展示两个处理选项（自动修复 / 忽略）
> - ✅ 等待用户明确回复后，再带上对应参数重新执行发布命令

---

## 1. 第三方资源安全检测

在正式上传之前，脚本会自动扫描项目中的 HTML、CSS、JS 文件，检测是否存在不合规的第三方外部资源引用。

> 白名单域名、检测范围等细节由 `@tencent/qn-page-deploy-rules` 包实现，脚本运行时会在 stdout 中输出完整信息（白名单列表、检测到的 URL、severity 级别、风险提示、处理建议），AI 直接读取脚本输出即可。

**Severity 级别**：
- 🔴 **ERROR** — 外部 JS 脚本（存在 XSS/供应链攻击风险）
- 🟡 **WARN** — 外部 CSS、图片、其他资源（不稳定但风险较低）
- 🔵 **INFO** — 建议性优化

**输出标记**：`[THIRD_PARTY_CHECK_START]` ... `[THIRD_PARTY_CHECK_END]`（JSON 格式，包含 `errors`、`warns`、`infos` 统计字段）

**Exit Code 含义**：
- `0` — 检测通过，无第三方资源
- `2` — 检测到第三方资源，需要用户决策
- `1` — 检测异常

### AI 交互流程

当检测到第三方资源时（exit code = 2），**必须**将脚本输出中的检测结果（含 severity 级别）和风险提示展示给用户，**等待用户明确回复后才能继续**（⚠️ 禁止 AI 自动代替用户选择）：

1. **展示 severity 级别统计**：如「发现 2 个 🔴 ERROR 高风险资源、3 个 🟡 WARN 中风险资源」
2. **展示脚本输出的检测结果**：包括每项资源的 severity 级别、不合规的第三方资源 URL、引用位置、建议处理方式
3. **展示脚本输出的风险提示**：脚本已输出完整的风险说明，直接转达给用户
4. **要求用户选择**（必须等待用户回复，不可自行决定）：
   - **自动处理（推荐）**：下载第三方资源到本地 assets 目录，改为相对路径引用
   - **忽略（不推荐）**：跳过检测，保留第三方引用继续发布

**用户选择"自动替换"后**，重新执行发布命令并追加 `--fix-third-party`：
```bash
node .codebuddy/skills/page-deploy/scripts/deploy.cjs <folderPath> <projectName> <env> --title-checked --fix-third-party
```

**用户选择"忽略"后**，重新执行发布命令并追加 `--skip-third-party-check`：
```bash
node .codebuddy/skills/page-deploy/scripts/deploy.cjs <folderPath> <projectName> <env> --title-checked --skip-third-party-check
```

**也可以单独运行检测（不发布）**：
```bash
node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs third-party <folderPath>
```

---

## 2. 外部字体资源检测

在第三方资源检测之后，脚本会扫描 HTML 和 CSS 文件中的外部字体引用（Google Fonts、Adobe Fonts 等）。检测到后建议替换为 SDK 提供的 `loadFont` API 动态加载预定义 CDN 字体。

> 检测域名、SDK 字体列表、字体映射规则等细节由 `@tencent/qn-page-deploy-rules` 包实现，脚本运行时会在 stdout 中输出完整信息（检测到的字体 URL、severity 级别、SDK 替换方案、风险提示），AI 直接读取脚本输出即可。

**Severity 级别**：
- 🟡 **WARN** — 外部字体样式表、字体文件引用（加载慢 + 隐私风险）
- 🔵 **INFO** — preconnect / dns-prefetch 标签（仅辅助性能标签）

**输出标记**：`[FONT_CHECK_START]` ... `[FONT_CHECK_END]`（JSON 格式，包含 `items`、`replacements`、`errors`、`warns`、`infos` 字段）

**Exit Code 含义**：
- `0` — 检测通过，无外部字体
- `2` — 检测到外部字体，需要用户决策
- `1` — 检测异常

### AI 交互流程

当检测到外部字体时（exit code = 2），**必须**将脚本输出中的检测结果（含 severity 级别）、SDK 替换方案和风险提示展示给用户，**等待用户明确回复后才能继续**（⚠️ 禁止 AI 自动代替用户选择）：

1. **展示 severity 级别统计**：如「发现 2 个 🟡 WARN 中风险资源、1 个 🔵 INFO 低风险资源」
2. **展示脚本输出的检测结果**：包括每项资源的 severity 级别、外部字体 URL、文件位置、行号
3. **展示脚本输出的 SDK 替换方案**：脚本已输出每个外部字体对应的 SDK 字体名称和 CDN 地址
4. **展示脚本输出的风险提示**：脚本已输出完整的风险说明，直接转达给用户
5. **要求用户选择**（必须等待用户回复，不可自行决定）：
   - **替换为 SDK 字体（推荐）** —— 删除外部字体引用，注入 SDK loadFont 调用，走白名单 CDN
   - **忽略（不推荐）** —— 保留外部字体引用继续发布

**用户选择"替换为 SDK 字体"后**，重新执行发布命令并追加 `--fix-font`：
```bash
node .codebuddy/skills/page-deploy/scripts/deploy.cjs <folderPath> <projectName> <env> --title-checked --fix-font
```

**用户选择"忽略"后**，重新执行发布命令并追加 `--skip-font-check`：
```bash
node .codebuddy/skills/page-deploy/scripts/deploy.cjs <folderPath> <projectName> <env> --title-checked --skip-font-check
```

**也可以单独运行检测（不发布）**：
```bash
node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs font <folderPath>
```

**单独运行修复（不发布）**：
```bash
node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs font <folderPath> --fix
```

> ⚠️ 修复模式会先展示字体处理方案（替换/删除明细），然后**等待用户输入 `y` 确认**后才会执行修改。输入其他内容或直接回车则取消操作。
> 
> 如果需要跳过确认（如自动化流水线调用），可追加 `--yes` 参数：
> ```bash
> node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs font <folderPath> --fix --yes
> ```

---

## 3. 公司内网链接检测

在第三方资源检测之后，脚本会扫描所有 HTML、CSS、JS 文件中的公司内网链接。内网链接发布到外网后无法访问，检测到后**展示问题列表和 severity 级别，等待用户确认处理方式**。

> 具体检测规则（域名模式等）由 `@tencent/qn-page-deploy-rules` 包实现，脚本运行时会在 stdout 中输出检测到的内网链接详情、severity 级别和风险提示，AI 直接读取脚本输出即可。

**Severity 级别**：
- 🔴 **ERROR** — 所有内网链接均为 ERROR 级别（外网完全不可访问）

**输出标记**：
- 检测：`[INTRANET_CHECK_START]` ... `[INTRANET_CHECK_END]`
- 修复：`[INTRANET_FIX_START]` ... `[INTRANET_FIX_END]`

**Exit Code 含义**：
- `0` — 检测通过，无内网链接
- `2` — 检测到内网链接，需要用户决策
- `1` — 检测异常

### AI 交互流程

当检测到内网链接时（exit code = 2），**必须**将脚本输出中的检测结果（含 severity 级别）和风险提示展示给用户，**等待用户明确回复后才能继续**（⚠️ 禁止 AI 自动代替用户选择）：

1. **展示 severity 级别统计**：如「发现 3 个 🔴 ERROR 高风险内网链接」
2. **展示脚本输出的检测结果**：包括每项资源的 severity 级别、内网链接 URL、引用位置、文件和行号
3. **展示脚本输出的风险提示**：脚本已输出完整的风险说明，直接转达给用户
4. **要求用户选择**（必须等待用户回复，不可自行决定）：
   - **自动删除（推荐）**：删除包含内网引用的代码
   - **忽略（不推荐）**：跳过检测，保留内网链接继续发布

> ⚠️ **强制约束 — 禁止 AI 自动代替用户做决策**
>
> 即使内网链接全部为 🔴 ERROR 级别，AI **也必须暂停并向用户展示检测结果，等待用户明确回复后才能继续**。
>
> **禁止行为**：
> - ❌ AI 自行判断"内网链接必须删除"后直接追加 `--fix-intranet` 参数重新运行
> - ❌ AI 替用户选择「自动删除」
> - ❌ 以"都是 ERROR 级别，必须删除"为由跳过用户确认
>
> **正确行为**：
> - ✅ 展示检测到的内网链接列表（含 severity 级别、URL、文件位置）
> - ✅ 展示两个处理选项（自动删除 / 忽略）
> - ✅ 等待用户明确回复后，再带上对应参数重新执行发布命令

**用户选择"自动删除"后**，重新执行发布命令并追加 `--fix-intranet`：
```bash
node .codebuddy/skills/page-deploy/scripts/deploy.cjs <folderPath> <projectName> <env> --title-checked --fix-intranet
```

**用户选择"忽略"后**，重新执行发布命令并追加 `--skip-intranet-check`：
```bash
node .codebuddy/skills/page-deploy/scripts/deploy.cjs <folderPath> <projectName> <env> --title-checked --skip-intranet-check
```

**也可以单独运行检测（不发布）**：
```bash
node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs intranet <folderPath>
```

**单独运行修复（不发布）**：
```bash
node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs intranet <folderPath> --fix
```
