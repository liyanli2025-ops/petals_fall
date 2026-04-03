# 配置与安装

## 首次使用 - 安装依赖

**重要**：首次使用此 skill 时，需要先安装依赖：

```bash
cd .codebuddy/skills/page-deploy && tnpm install
```

如果遇到权限问题（如 `.tnpm` 目录权限错误），请执行：
```bash
sudo chown -R $(whoami) ~/.tnpm
```

然后重新安装依赖。

---

## 配置检查

在上传前，脚本会自动检查配置是否完整。如果配置不完整，会输出包含 `[CONFIG_MISSING_START]` 和 `[CONFIG_MISSING_END]` 标记的 JSON 数据。

### 配置项说明

| 配置项 | 说明 | 申请地址 |
|--------|------|----------|
| TUPLOAD_TOKEN | CDN 上传 token | https://fupload.woa.com/create |
| FUPLOAD_TOKEN | HTML 服务器上传 token | https://fupload.woa.com/createnews |
| FOLDER_NAME | 上传路径名称 | 用户申请时填写的路径 |

### 配置引导流程

当检测到配置缺失时，按以下流程引导用户：

1. **缺少 TUPLOAD_TOKEN**：
   - 引导用户访问 https://fupload.woa.com/create 申请
   - 用户需要填写上传路径（如 `activity/myproject`）并获取 token

2. **缺少 FUPLOAD_TOKEN**：
   - 引导用户访问 https://fupload.woa.com/createnews 申请
   - **重要提示**：用户填写的路径必须与申请 TUPLOAD_TOKEN 时一致

3. **缺少 FOLDER_NAME**：
   - 即用户在申请 token 时填写的路径名称（如 `activity/myproject`）

### 用户反馈格式

引导用户按以下格式提供配置信息：

```
素材上传的token是xxx
正式域名上传的token是xxx
上传路径是xxx
```

收到用户反馈后，解析并执行以下命令自动配置：

```bash
node .codebuddy/skills/page-deploy/scripts/deploy.cjs --set-config TUPLOAD_TOKEN <素材上传的token>
node .codebuddy/skills/page-deploy/scripts/deploy.cjs --set-config FUPLOAD_TOKEN <正式域名上传的token>
node .codebuddy/skills/page-deploy/scripts/deploy.cjs --set-config FOLDER_NAME <上传路径>
```

### 配置完成确认

每次更新配置后，脚本会自动检查剩余缺失项。当所有配置完成时，会输出：
```
🎉 所有配置已完成，可以开始上传了！
```

---

## CDN 配置参考 (tupload)

```javascript
{
  site: 'mat1.gtimg.com',
  baseUrl: '/qqcdn/<FOLDER_NAME>/<projectName>',
  token: '<TUPLOAD_TOKEN>',
}
```

## HTML 服务器配置参考 (fupload)

```javascript
// 测试环境
{
  site: 'testqqnews.qq.com',
  baseUrl: '/qqfile/<FOLDER_NAME>/<projectName>.html',
  token: '<FUPLOAD_TOKEN>',
}

// 正式环境
{
  site: 'h5.news.qq.com',
  baseUrl: '/qqfile/<FOLDER_NAME>/<projectName>.html',
  token: '<FUPLOAD_TOKEN>',
}
```

---

## npm 包机制

核心发布逻辑已提取为独立 npm 包 `@tencent/qn-page-deploy`，规则检测由 `@tencent/qn-page-deploy-rules` 提供。

skill 目录仅作为入口壳，每次执行时自动检测 npm 包版本并更新，确保用户始终使用最新代码。

**工作原理**：
- `scripts/deploy.cjs`（壳）→ 设置环境变量 → 检测 `@tencent/qn-page-deploy` 版本 → 代理调用 npm 包中的 `deploy.cjs`
- npm 包中的 `deploy.cjs` → 检测 `@tencent/qn-page-deploy-rules` 版本 → 执行发布流程
- 两层版本检测确保核心逻辑和规则检测都是最新的

**新增规则**：
- 只需在 `@tencent/qn-page-deploy-rules` 包的 `rules/` 目录下新增检测脚本
- 在 `index.cjs` 的 `RULES` 数组中注册
- 发布新版本后，所有用户下次发布时自动获取新规则

**手动更新包**：
```bash
cd .codebuddy/skills/page-deploy && npm update @tencent/qn-page-deploy
```

**列出所有可用规则**：
```bash
node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs --list
```

**单独运行某条规则**：
```bash
node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs <ruleId> <folderPath> [--preview] [--fix] [--yes]
```

**预览模式**（只展示问题和 severity 级别，不修改文件）：
```bash
node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs <ruleId> <folderPath> --preview
```
