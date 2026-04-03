---
name: image-upload
description: 批量上传图片到 CDN。支持拖入图片或图片文件夹，自动压缩后上传，输出 CDN URL 列表。
---

# 图片批量上传到 CDN

将用户提供的图片或图片文件夹，自动压缩并上传到 CDN。

---

## 首次使用 - 配置检查

在上传前，脚本会自动检查配置是否完整。如果配置不完整，会输出包含 `[CONFIG_MISSING_START]` 和 `[CONFIG_MISSING_END]` 标记的 JSON 数据。

### 配置项说明

| 配置项 | 说明 | 申请地址 |
|--------|------|----------|
| TUPLOAD_TOKEN | CDN 上传 token | https://fupload.woa.com/create |
| FOLDER_NAME | 上传路径名称 | 用户申请时填写的路径 |

### 配置引导流程

当检测到配置缺失时，按以下流程引导用户：

1. **缺少 TUPLOAD_TOKEN**：
   - 引导用户访问 https://fupload.woa.com/create 申请
   - 用户需要填写上传路径（如 `activity/myproject`）并获取 token

2. **缺少 FOLDER_NAME**：
   - 即用户在申请 token 时填写的路径名称（如 `activity/myproject`）

### 用户反馈格式

引导用户按以下格式提供配置信息：

```
token是xxx
上传路径是xxx
```

收到用户反馈后，解析并执行以下命令自动配置：

```bash
node .codebuddy/skills/image-upload/scripts/upload.cjs --set-config TUPLOAD_TOKEN <token值>
node .codebuddy/skills/image-upload/scripts/upload.cjs --set-config FOLDER_NAME <上传路径>
```

### 配置完成确认

每次更新配置后，脚本会自动检查剩余缺失项。当所有配置完成时，会输出：
```
🎉 所有配置已完成，可以开始上传了！
```

---

## 使用流程

### 1. 收集信息

**确认图片路径**：

用户需要提供图片文件或图片文件夹路径。支持以下方式：
- 拖入单个图片文件
- 拖入包含图片的文件夹
- 直接提供路径

### 2. 执行上传

执行以下命令进行压缩 + 上传：

```bash
node .codebuddy/skills/image-upload/scripts/upload.cjs <图片路径或文件夹路径>
```

示例：
```bash
# 上传单个图片
node .codebuddy/skills/image-upload/scripts/upload.cjs /Users/xxx/Desktop/banner.png

# 上传整个文件夹
node .codebuddy/skills/image-upload/scripts/upload.cjs /Users/xxx/Desktop/images
```

### 3. 上传流程说明

脚本会自动执行以下步骤：

1. **检查配置**：验证 token 和上传路径是否已配置
2. **扫描图片**：支持 `.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`、`.svg`、`.ico` 格式
3. **压缩图片**：使用 Tinify API 压缩（SVG/GIF/ICO 不压缩，直接上传）
4. **上传到 CDN**：使用 tupload 上传到 CDN
5. **输出结果**：输出 CDN URL 列表，方便复制使用

---

## 上传结果

脚本会自动将中文文件名转换为拼音（英文），并输出 Markdown 表格，包含原路径和 CDN URL：

```markdown
✅ 上传结果表格:

| 原路径 | CDN 路径 |
|--------|---------|
| /Users/xxx/Desktop/测试.png | https://mat1.gtimg.com/qqcdn/xxx/ceshi.png |
| /Users/xxx/Desktop/banner.jpg | https://mat1.gtimg.com/qqcdn/xxx/banner.jpg |
```

---

## 使用示例

**用户**：帮我上传这些图片 [拖入文件夹]

**AI**：检测到图片文件夹，开始处理...

（执行脚本）

上传完成！这是上传结果表格：

| 原路径 | CDN 路径 |
|--------|---------|
| /Users/xxx/Desktop/测试.png | https://mat1.gtimg.com/qqcdn/xxx/ceshi.png |
| /Users/xxx/Desktop/banner.jpg | https://mat1.gtimg.com/qqcdn/xxx/banner.jpg |

---

## 首次使用 - 安装依赖

**重要**：首次使用此 skill 时，需要先安装依赖：

```bash
cd .codebuddy/skills/image-upload && tnpm install
```

如果遇到权限问题（如 `.tnpm` 目录权限错误），请执行：
```bash
sudo chown -R $(whoami) ~/.tnpm
```

然后重新安装依赖。

---

## 注意事项

1. **图片格式**：支持 png, jpg, jpeg, webp, gif, svg, ico
2. **压缩格式**：Tinify 仅压缩 png, jpg, jpeg, webp；gif/svg/ico 直接上传
3. **文件大小**：单个文件不超过 10MB
4. **递归扫描**：文件夹模式下会递归扫描所有子目录
5. **文件名处理**：自动将中文文件名转换为拼音字母，并过滤特殊字符以避免 CDN 链接失效