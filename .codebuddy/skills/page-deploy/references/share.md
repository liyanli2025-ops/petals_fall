# 分享能力检测与注入

在确认页面标题之后，AI **必须**检测页面是否具备分享能力，并**强制询问**用户是否需要添加。

## 检测方式

扫描 HTML 和 JS 文件，检查是否存在以下分享能力的特征：

1. **JS 分享调用**：搜索是否包含 `setShare`、`wxShare`、`setShareInfo`、`WeixinJSBridge`、`menu:share:timeline`、`menu:share:appmessage`、`og:title`、`og:description`、`og:image` 等关键词
2. **分享 meta 标签**：检查 HTML 的 `<head>` 中是否已存在 `og:title`、`og:description`、`og:image` 等 Open Graph meta 标签
3. **QQ 分享脚本**：检查是否引用了 `qzonestyle.gtimg.cn/qzone/qzact/common/share/share.js`

## 判定规则

- 如果**同时具备** JS 分享调用 和 分享 meta 标签 → 判定为「已有分享能力」
- 如果**仅有部分**（如只有 meta 标签但无 JS 调用）→ 判定为「分享能力不完整」
- 如果**均不存在** → 判定为「无分享能力」

---

## 已有分享能力

如果检测到页面已具备完整的分享能力，展示当前分享配置并提示用户确认：

```
✅ 检测到页面已具备分享能力。

当前分享配置：
- 分享标题：「xxx」（来自 og:title / setShare 调用）
- 分享描述：「xxx」（来自 og:description）
- 分享图标：「xxx」（来自 og:image）

是否需要修改分享信息？回复修改内容，或回复"确认"继续发布。
```

---

## 无分享能力 / 分享能力不完整

如果检测到页面**没有**或**不完整的**分享能力，**必须强制询问**用户：

```
⚠️ 检测到页面缺少分享能力。

H5 页面在微信/QQ/腾讯新闻中被分享时，没有分享能力会导致：
- 分享卡片无标题和描述，显示为默认链接
- 无法自定义分享图标，体验不佳
- 在腾讯新闻端内无法使用分享菜单

是否需要添加分享功能？
1. **添加分享功能（推荐）** — 自动注入分享代码，支持微信/QQ/腾讯新闻端内分享
2. **不需要** — 跳过分享功能，直接发布
```

> ⚠️ **此步骤为强制询问**，AI 不可自行跳过，必须等待用户明确回复。

---

## 用户选择"添加分享功能"后的处理

当用户选择添加分享功能时，按以下步骤操作：

### Step 1：收集分享信息

```
请提供分享信息（未提供的项将使用默认值）：
1. 分享标题：（默认使用页面标题「xxx」）
2. 分享描述：（如：参与活动赢大奖）
3. 分享图标 URL：（如：https://mat1.gtimg.com/qqcdn/xxx/share-icon.png）

提示：分享图标建议尺寸 200x200，图标 URL 必须使用白名单域名。
```

### Step 2：注入分享代码

根据用户提供的分享信息，AI 需要完成以下操作：

1. **在 HTML 的 `<head>` 中添加 Open Graph meta 标签**：

```html
<meta property="og:title" content="分享标题">
<meta property="og:description" content="分享描述">
<meta property="og:image" content="分享图标URL">
<meta property="og:url" content="页面访问地址">
```

2. **注入分享 JS 代码**：

参考 `@tencent/qn-page-deploy` 包中 `templates/share.ts` 和 `templates/share-utils.ts` 的代码模板（路径：`node_modules/@tencent/qn-page-deploy/templates/`），将以下能力注入到页面中：

- **UA 判断工具函数**（`isQQNews`、`isWeixin`、`isBrowser`）— 来自 `share-utils.ts`
- **分享功能核心代码**（`setShare`、`wxShare`、`setMetaContent`）— 来自 `share.ts`
- **页面加载时自动调用 `setShare`**，传入用户提供的分享参数

注入方式（根据页面结构选择最合适的方式）：

- **方式 A：内联注入**（适合简单页面）— 将工具函数和分享代码以 `<script>` 标签形式直接写入 HTML 的 `</body>` 前
- **方式 B：独立文件注入**（适合已有 JS 模块化结构的页面）— 创建 `share-utils.js` 和 `share.js` 文件到页面的 `js/` 目录下，并在 HTML 中引用

> ⚠️ **注意事项**：
> - 注入的代码需要转换为纯 JavaScript（去除 TypeScript 类型注解）
> - 分享图标 URL 必须使用白名单域名（如 `mat1.gtimg.com`），不得使用外部域名
> - 如果用户提供了本地图片路径作为分享图标，应在后续上传步骤中一并上传到 CDN，并在上传完成后更新 meta 标签中的图标 URL
> - QQ 分享脚本 `https://qzonestyle.gtimg.cn/qzone/qzact/common/share/share.js` 属于白名单域名，可直接引用
> - 注入的 `setShare` 调用应在 `DOMContentLoaded` 事件中执行

### Step 3：确认注入结果

完成注入后，向用户展示：

```
✅ 已添加分享功能！

注入内容：
- [文件名] 中添加了 Open Graph meta 标签
- [文件名] 中注入了分享代码（支持微信/QQ/腾讯新闻端内分享）

分享信息：
- 标题：「xxx」
- 描述：「xxx」
- 图标：「xxx」
- 链接：「xxx」

继续执行上传...
```
