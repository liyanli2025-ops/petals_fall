# Image Upload / 图片批量上传

> Batch compress & upload images to CDN — drag, drop, done.
>
> 一键压缩 + 上传图片到 CDN，拖入即用，输出可用的 CDN URL 列表。

---

## ✨ Features / 功能特性

| Feature / 功能 | Description / 说明 |
|---|---|
| 🖼️ Batch Upload / 批量上传 | 支持拖入单个图片或整个文件夹，一次性批量上传 |
| 🗜️ Auto Compress / 自动压缩 | 使用 Tinify API 自动压缩图片，平均节省 60%~70% 体积 |
| 📂 Recursive Scan / 递归扫描 | 文件夹模式下自动递归扫描所有子目录中的图片 |
| 🔤 Filename Normalization / 文件名规范化 | 自动将中文文件名转换为拼音，过滤特殊字符，确保 CDN 链接可用 |
| 📋 Result Table / 结果表格 | 上传完成后输出 Markdown 表格 + JSON，方便复制使用 |
| ⏭️ Smart Skip / 智能跳过 | 已上传过的图片自动跳过，避免重复上传 |

### Supported Formats / 支持格式

| 类型 | 格式 | 是否压缩 |
|------|------|----------|
| 图片 | `.png` `.jpg` `.jpeg` `.webp` | ✅ Tinify 压缩后上传 |
| 动图/矢量/图标 | `.gif` `.svg` `.ico` | ⏭️ 直接上传（不压缩） |

---

## 🚀 Quick Start / 快速开始

### 1. Install Dependencies / 安装依赖（仅首次）

```bash
cd .codebuddy/skills/image-upload && tnpm install
```

> 如果遇到权限问题（如 `.tnpm` 目录权限错误），请先执行：
> ```bash
> sudo chown -R $(whoami) ~/.tnpm
> ```

### 2. Configure / 配置（仅首次）

首次使用时，脚本会自动检测配置是否完整并引导你完成配置。

| Config / 配置项 | Description / 说明 | Where to Get / 申请地址 |
|---|---|---|
| `TUPLOAD_TOKEN` | CDN 上传 token | [fupload.woa.com/create](https://fupload.woa.com/create) |
| `FOLDER_NAME` | CDN 上传路径（申请 token 时填写的路径） | 同上 |

配置命令：

```bash
node .codebuddy/skills/image-upload/scripts/upload.cjs --set-config TUPLOAD_TOKEN <your_token>
node .codebuddy/skills/image-upload/scripts/upload.cjs --set-config FOLDER_NAME <your_path>
```

### 3. Usage / 使用方式

在对话中拖入图片或文件夹，说 **"帮我上传这些图片"** 即可。

也可以直接通过命令行上传：

```bash
# Upload a single image / 上传单个图片
node .codebuddy/skills/image-upload/scripts/upload.cjs /path/to/image.png

# Upload all images in a folder / 上传文件夹中所有图片
node .codebuddy/skills/image-upload/scripts/upload.cjs /path/to/images/
```

---

## 📖 How It Works / 工作流程

```
拖入图片/文件夹
     ↓
① 检查配置（Check Config）
     ↓
② 递归扫描图片文件（Scan Images）
     ↓
③ 压缩图片 — Tinify API（Compress）
     ↓
④ 上传到 CDN — tupload（Upload）
     ↓
⑤ 输出结果表格 + JSON（Output）
```

---

## 📋 Output Example / 输出示例

上传完成后，脚本会输出 Markdown 表格和 JSON 两种格式：

**Markdown 表格：**

| 原路径 | CDN 路径 |
|--------|---------|
| /Users/xxx/Desktop/测试.png | https://mat1.gtimg.com/qqcdn/xxx/ce-shi.png |
| /Users/xxx/Desktop/banner.jpg | https://mat1.gtimg.com/qqcdn/xxx/banner.jpg |

**JSON 格式：**

```json
[
  {
    "originalPath": "/Users/xxx/Desktop/测试.png",
    "filename": "ce-shi.png",
    "cdnUrl": "https://mat1.gtimg.com/qqcdn/xxx/ce-shi.png"
  }
]
```

---

## ⚠️ Notes / 注意事项

1. **File Size Limit / 文件大小限制**：单个文件不超过 10MB
2. **Filename Handling / 文件名处理**：中文文件名会自动转换为拼音，特殊字符会被过滤
3. **Duplicate Detection / 重复检测**：已上传的图片会自动跳过，不会重复上传
4. **Network / 网络要求**：需要内网环境访问 tupload 服务

---

## 🛠️ Tech Stack / 技术栈

| Package | Purpose / 用途 |
|---------|----------------|
| `@tencent/tupload2` | CDN 上传客户端 |
| `tinify` | 图片压缩（TinyPNG API） |
| `pinyin-pro` | 中文文件名转拼音 |
| `chalk` | 终端彩色输出 |

---

## 📬 Contact / 联系人

| | |
|---|---|
| **Maintainer / 维护者** | luckylisali |
| **RTX** | luckylisali |

如有问题或建议，欢迎联系 👆
