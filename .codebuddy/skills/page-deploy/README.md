# 页面发布 Skill

一键发布 H5 页面，自动处理资源上传 CDN、路径替换和依赖打包。

**作者**：luckylisali

## 快速开始

### 1. 安装依赖（仅首次）

```bash
cd .codebuddy/skills/page-deploy && tnpm install
```

### 2. 使用方式

1. 拖入文件夹，说 **"帮我发布这个页面"**
2. 首次使用会引导配置 token（只需配置一次）
3. 之后每次发布只需确认页面名称即可

## 功能特性

### 资源处理
- ✅ 自动检测 HTML、CSS、JS、图片资源
- ✅ 自动替换相对路径为 CDN 绝对路径
- ✅ 上传图片、CSS、JS 到 CDN，上传 HTML 到服务器
- ✅ CSS/JS 文件内容哈希处理（`filename.[hash].ext`），避免 CDN 缓存问题
- ✅ ES Module 自动打包（检测到 `import/export` 语法时使用 esbuild 打包）
- ✅ 源文件保护：所有操作在临时副本上执行，不修改源文件夹

### 发布管理
- ✅ 支持测试环境（默认）和正式环境
- ✅ 正式环境发布需二次确认，防止误发
- ✅ 页面名称智能推荐（中文/特殊字符自动转英文）
- ✅ 页面标题（`<title>`）确认与修改
- ✅ 首次使用引导配置 token，配置信息持久化

### 安全检测（规则包机制）
- ✅ 第三方资源安全检测（按 ERROR/WARN/INFO 分级，支持自动下载到本地）
- ✅ 外部字体资源检测（Google Fonts、Adobe Fonts 等）
- ✅ 公司内网链接检测（localhost、内网 IP、`.woa.com` 等）
- ✅ 规则包自动更新（基于 `@tencent/qn-page-deploy-rules`，新增规则自动获取）
- ✅ 预览→确认→修复流程，所有检测结果展示给用户确认后再处理

### 分享能力
- ✅ 自动检测页面分享能力（Open Graph meta 标签、微信/QQ 分享 JS 调用）
- ✅ 一键注入分享代码（支持微信、QQ、腾讯新闻端内分享）
- ✅ 自定义分享标题、描述、图标

## 配置说明

首次使用需要申请两个 token：

| 配置项 | 说明 | 申请地址 |
|--------|------|----------|
| 素材上传 token（TUPLOAD_TOKEN） | CDN 资源上传 | https://fupload.woa.com/create |
| 正式域名 token（FUPLOAD_TOKEN） | HTML 页面上传 | https://fupload.woa.com/createnews |

⚠️ **重要**：两次申请时填写的路径（FOLDER_NAME）必须一致！

## 上传结果

**测试环境**：`https://testqqnews.qq.com/qqfile/<路径>/<页面名>.html`

**正式环境**：`https://h5.news.qq.com/qqfile/<路径>/<页面名>.html`

## 架构说明

核心逻辑由 npm 包提供，skill 目录仅作为入口壳，每次执行时自动检测版本并更新：

- `@tencent/qn-page-deploy` — 发布核心逻辑（上传、路径替换、打包等）
- `@tencent/qn-page-deploy-rules` — 规则检测包（第三方资源、字体、内网链接等）

手动更新：
```bash
cd .codebuddy/skills/page-deploy && npm update @tencent/qn-page-deploy @tencent/qn-page-deploy-rules
```
