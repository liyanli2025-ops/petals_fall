# 花瓣雨 AR 全息 — 技术方案文档

> **项目名称**：花瓣雨（Petals Fall）  
> **体验地址**：https://testqqnews.qq.com/qqfile/redian/petals_fall.html  
> **技术栈**：原生 HTML5 + CSS3 + JavaScript（零框架）  
> **核心依赖**：Three.js r149 + MediaPipe SelfieSegmentation  
> **兼容目标**：iOS Safari 14+、Android Chrome 80+、PC 现代浏览器

---

## 一、项目概述

在手机浏览器中实现一个 **AR 花瓣雨** 体验：打开摄像头，漫天花瓣从天而降，花瓣会停落在人物肩膀/手臂上，用户转动手机可 360° 环视花海，支持拍照和录像保存。

**核心交互**：
- 🌸 3000 片花瓣实时飘落，8 种贴图 + 4 种几何形状
- 📱 陀螺仪 360° 环视 + 加速度计平移视差
- 👤 AI 人体分割，花瓣停留在肩膀/手臂/手掌上
- 🌪️ 人物大动作触发涡流，花瓣被卷起旋转
- 📸 拍照 / 录像合成输出，含运动模糊效果

---

## 二、系统架构

```
┌─────────────────────────────────────────────────────┐
│                    动画主循环 (60fps)                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 陀螺仪    │  │ 摄像头    │  │ 人体分割           │  │
│  │ Gyroscope │  │ Camera   │  │ MediaPipe WASM    │  │
│  │ Manager   │  │ Manager  │  │ + GPU推理          │  │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│       │              │                  │              │
│       ▼              ▼                  ▼              │
│  ┌──────────────────────────────────────────────┐    │
│  │         花瓣粒子系统 (PetalParticleSystem)      │    │
│  │  ┌────────────────────────────────────────┐  │    │
│  │  │  8 逻辑层 → 3 渲染层 (InstancedMesh)     │  │    │
│  │  │  ┌──────┐  ┌──────┐  ┌──────┐          │  │    │
│  │  │  │ 远景  │  │ 中景  │  │ 近景  │          │  │    │
│  │  │  │(far) │  │(mid) │  │(near)│          │  │    │
│  │  │  └──────┘  └──────┘  └──────┘          │  │    │
│  │  │  ← 单 WebGL Context, 3-pass 渲染 →      │  │    │
│  │  └────────────────────────────────────────┘  │    │
│  │  碰撞检测 · 涡流系统 · 风场 · 阵风            │    │
│  └──────────────────────────────────────────────┘    │
│       │                                               │
│       ▼                                               │
│  ┌──────────────────────────────────────────────┐    │
│  │  屏幕合成 (CSS Layer)                          │    │
│  │  z=1 摄像头视频                                │    │
│  │  z=1 远景花瓣 (CSS blur 1px)                   │    │
│  │  z=2 人物遮罩层                                │    │
│  │  z=3 中景花瓣 (清晰)                           │    │
│  │  z=5 近景花瓣 (CSS blur 4px)                   │    │
│  │  z=10 UI 控制层                                │    │
│  └──────────────────────────────────────────────┘    │
│       │                                               │
│       ▼                                               │
│  ┌──────────────────────────────────────────────┐    │
│  │  拍照/录像 (CaptureManager)                    │    │
│  │  离屏合成 + 运动模糊 + Web Share / 下载         │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

---

## 三、技术难点与解决方案

### 难点 1：WebGL Context 数量限制

**问题**：移动端浏览器通常只允许 2~4 个 WebGL Context，超出后会丢失旧的。本项目需要花瓣渲染 + MediaPipe 推理（内部使用 WebGL），极易超限。

**解决方案**：

| 方案 | 说明 |
|------|------|
| **单 WebGL + 3-pass 渲染** | 所有花瓣共用 1 个隐藏的 WebGL canvas，通过 3 次渲染 pass（每次只显示一层 mesh），将结果 `drawImage` 到 3 个 2D canvas |
| **CSS blur 代替 WebGL 后处理** | 景深模糊不在 WebGL 中做（省掉 framebuffer），而是用 CSS `filter: blur()` 作用在 2D canvas 上，利用浏览器 GPU 合成 |
| **Context Lost 自动恢复** | 监听 `webglcontextlost` / `webglcontextrestored` 事件，丢失 2 秒后自动重建 renderer、重新上传 texture/geometry |

### 难点 2：花瓣停留在人物身上

**问题**：如何让 3D 空间中的花瓣感知 2D 屏幕上的人物轮廓，实现"停靠"效果？

**解决方案 — 3D→2D 投影碰撞检测**：

1. MediaPipe SelfieSegmentation 输出人物蒙版（256×256）
2. 蒙版缩小到 60×80 低分辨率，按列扫描提取**上边缘轮廓线**
3. 每帧将花瓣 3D 坐标通过 `Vector3.project(camera)` 投影到屏幕 2D 坐标
4. 判断花瓣屏幕坐标是否接近人物轮廓上边缘 → 触发碰撞
5. **排除头部区域**（上部 55%），只让花瓣停留在肩膀/手臂/手掌上
6. 花瓣状态机：`falling → landing → resting → sliding → falling`（含着陆过渡动画）

**关键细节**：
- `object-fit: cover` 坐标映射：蒙版是视频原始比例，屏幕是窗口比例，需要精确计算裁剪偏移
- 人物距离感知：通过蒙版面积占比估算人物远近，人太近时禁用碰撞（避免花瓣遮脸）
- 碰撞上限 3 片：防止花瓣堆积影响画面

### 难点 3：陀螺仪 360° 环视（万向锁）

**问题**：欧拉角方案在极端角度会发生万向锁（Gimbal Lock），导致视角突然跳转。

**解决方案**：

- 使用 **四元数（Quaternion）** 方案：从 `DeviceOrientation` 的 alpha/beta/gamma 构建设备四元数
- 参考 Three.js `DeviceOrientationControls` 标准算法：
  - 手机坐标系 → WebGL 坐标系补偿（绕 X 轴 -90°）
  - 屏幕方向补偿（横屏时绕 Z 轴旋转）
- 使用 `Quaternion.slerp()` 做帧间平滑插值，避免抖动
- 加速度计双重积分 → 平移视差（低通滤波 + 速度衰减 + 偏移回弹）

### 难点 4：iOS Safari 权限链

**问题**：iOS Safari 要求 `DeviceOrientationEvent.requestPermission()` 和 `getUserMedia()` 都必须在用户手势（user activation）窗口内调用，而且 user activation 有超时限制。

**解决方案**：

1. 启动按钮同时绑定 `click` + `touchend`（iOS 上 `touchend` 更可靠）
2. 在同一个用户交互回调内**串行请求**陀螺仪和摄像头权限
3. 摄像头 stream 在 `app.js` 中获取后传给 `CameraManager.initWithStream()`，避免二次请求

### 难点 5：拍照/录像合成

**问题**：屏幕上的效果是多层 CSS 叠加（视频 + 3 层花瓣 + 人物遮罩），但导出时需要合成为单张图片 / 单路视频流。

**解决方案**：

- 创建离屏 `compositeCanvas`，按正确 z-order 逐层绘制
- **跳过人物遮罩层**：底层视频已包含完整人物画面，再叠遮罩会导致 alpha blend 二次残影
- 前置摄像头需 `ctx.scale(-1, 1)` 做镜像翻转
- 拍照用 3x DPR 高清，录像降为 1x 保性能
- **模糊半径 DPR 补偿**：合成 canvas 分辨率是屏幕的 N 倍（DPR=3 时为 3 倍），模糊半径需等比放大，否则等效 CSS blur 效果只有 1/3
- **WebGL GPU 高斯模糊**（`js/webgl-blur.js`）：iOS Safari 不支持 `ctx.filter = 'blur()'`，改用独立 WebGL context 实现两 pass 分离式高斯模糊（水平+垂直，9-tap 高斯核），效果等同 CSS `filter: blur()`。大模糊值自动分成多轮 pass。三级降级链：WebGL GPU blur → Canvas 2D filter → 多轮缩放模糊
- 录像使用 `MediaRecorder` + `captureStream(30)`，编码优先 MP4/AVC1
- 录像时跳过 WebGL blur 和运动模糊（单帧合成 ~3ms），确保合成帧率匹配 captureStream 要求
- 保存策略分级降级：Web Share API（iOS/Android 原生保存）→ `<a download>`（PC）→ 视频预览弹窗（微信/降级）
- 录像中禁用摄像头切换/开关按钮，防止视频流断裂

---

## 四、技术亮点

### 亮点 1：8 逻辑层 → 3 渲染层景深系统

```
逻辑层              渲染层         视觉效果
──────────────────────────────────────────
dust     (8%)  ──┐
veryFar (12%)  ──┤
far     (14%)  ──┼── far  ──── CSS blur(1px) + 75% 透明度
midFar  (14%)  ──┘
mid     (16%)  ──┤
midNear (12%)  ──┼── mid  ──── 清晰、全透明度
near    (14%)  ──┤
veryNear(10%)  ──┼── near ──── CSS blur(4px) + 55% 透明度
```

- 每个逻辑层有独立的**大小范围、飘落速度、空间分布半径**
- 远景用 `MeshBasicMaterial`（纯贴图，无光照计算），近景用 `MeshPhysicalMaterial`（PBR，有 clearcoat 和 transmission 质感）
- 花瓣几何体有**弯曲、卷边、扭曲**变形（8×8 细分 PlaneGeometry + 顶点位移）

### 亮点 2：涡流系统（人物交互驱动）

人物做大幅度动作时，系统通过蒙版重心偏移和面积变化检测运动强度，自动在人物位置生成 3D 涡流：

- **切向力**：花瓣沿 XZ 平面旋转（顺/逆时针跟随运动方向）
- **向心力**：微弱吸引力防止花瓣飞散
- **上升力**：花瓣被卷起上浮
- **钟形衰减**：0.3r 处力最强，边缘渐弱，中心无奇点
- **渐入渐出**：0.2s 启动延迟 + 生命衰减（1.8~3.3s）

涡流可以把 `resting` 状态的花瓣重新吹起！

### 亮点 3：花瓣状态机（Landing → Resting → Sliding）

```
            ┌──────────────────────┐
            │      falling         │ ← 正常飘落
            │  (风场+摇摆+螺旋+翻转)│
            └──────┬───────────────┘
                   │ 碰撞检测命中
                   ▼
            ┌──────────────────────┐
            │      landing         │ ← 着陆过渡 (0.25~0.5s)
            │  速度 ease-out 衰减   │    旋转趋平 + 微弹
            └──────┬───────────────┘
                   │ 过渡完成
                   ▼
            ┌──────────────────────┐
            │      resting         │ ← 停留 (1.5~3.5s)
            │  呼吸起伏 + 翘边颤动  │    受风微扰 + 涡流可吹起
            └──────┬───────────────┘
                   │ 超时 / 离开人物区域
                   ▼
            ┌──────────────────────┐
            │      sliding         │ ← 滑落
            │  侧翻 + 横向漂移     │    阵风再捕获 (1.5% 概率)
            └──────┬───────────────┘
                   │ 速度过快 / 飞出范围
                   ▼
                 回到 falling（回收重生）
```

每个状态都有精心调校的物理参数，让花瓣的停留 → 滑落过程看起来自然而非突兀。

### 亮点 4：拍照/录像运动模糊

录像时快速飘落的花瓣在单帧中是"冻结"的，缺乏动感。通过**多帧累积**实现运动模糊：

- 维护 3 个离屏 canvas 的 **Ring Buffer**，存储最近 3 帧花瓣层快照
- 合成时先叠加历史帧（透明度递减：0.12 → 0.20 → 0.30），再叠当前帧
- 快速移动的花瓣 → 帧间位移大 → 自然产生沿运动方向的拖影
- 静止花瓣 → 位置不变 → 叠加后仍清晰
- 只在拍照/录像时生效，实时预览零额外开销

### 亮点 5：自适应性能调优

```javascript
// 每 5 秒检测一次，FPS < 15 时自动减少花瓣
autoTunePerformance() {
  if (fps < 15 && petalCount > 500) {
    setPetalCount(petalCount - Math.floor(petalCount * 0.08));
  }
}
```

| 优化项 | 策略 |
|-------|------|
| 花瓣数量 | 移动端默认 2000，PC 端 3000，可滑动条调节 |
| DPR 限制 | WebGL 限制 1.5x，2D canvas 限制 2x |
| 分割降频 | 移动端每 3 帧推理一次，中间帧复用旧蒙版 |
| 碰撞采样 | 60×80 低分辨率，非逐像素 |
| 远景材质 | BasicMaterial（无光照计算） |
| 录像分辨率 | 1x DPR（拍照 2x） |
| Context 恢复 | WebGL 丢失后 2s 自动重建 |

### 亮点 6：零外部依赖的离线化

- Three.js r149 本地化（`libs/three.min.js`）
- MediaPipe SelfieSegmentation 模型文件本地化（`.tflite` + `.wasm`）
- 部署后通过检测 `window.location.href` 自动切换本地路径 / CDN 路径
- 8 张花瓣贴图内嵌项目（PNG 格式，带 alpha 通道）
- **零第三方域名引用**

---

## 五、文件结构

```
flowers/
├── index.html              # 入口页面，多层 canvas 架构
├── css/
│   └── style.css           # 样式（响应式 + safe-area + 动画）
├── js/
│   ├── app.js              # 主控制器（权限、初始化、动画循环）
│   ├── camera.js           # 摄像头模块（前/后置切换、镜像）
│   ├── gyroscope.js        # 陀螺仪/加速度计/鼠标控制
│   ├── particles.js        # 花瓣粒子系统（InstancedMesh + 物理模拟）
│   ├── segmentation.js     # MediaPipe 人体分割
│   ├── body-collision.js   # 碰撞检测 + 运动检测 + 涡流触发
│   ├── webgl-blur.js       # WebGL GPU 高斯模糊后处理（iOS Safari 兼容）
│   └── capture.js          # 拍照/录像（合成 + 运动模糊 + 保存）
├── libs/
│   ├── three.min.js        # Three.js r149
│   └── mediapipe/          # MediaPipe 本地化（JS + WASM + TFLite）
└── 1~8.png                 # 8 种花瓣贴图
```

---

## 六、关键参数速查

| 参数 | 值 | 说明 |
|------|---|------|
| 花瓣总数 | 2000（移动端）/ 3000（PC） | 用户可通过滑动条在 200~5000 间调节 |
| 逻辑层数 | 8 | dust / veryFar / far / midFar / mid / midNear / near / veryNear |
| 渲染层数 | 3 | far / mid / near，3-pass 渲染 |
| WebGL Context | 3 | 1 花瓣渲染 + 1 MediaPipe + 1 高斯模糊后处理 |
| 花瓣贴图 | 8 种 | 1.png ~ 8.png |
| 花瓣几何 | 4 种 | 不同宽高比 + 弯曲参数的 PlaneGeometry(8×8) |
| 碰撞采样 | 60×80 | 蒙版缩小后按列扫描 |
| 分割频率 | 每 2~3 帧 | 移动端 3 帧，PC 2 帧 |
| 涡流上限 | 3 个同时 | 冷却 1.5s，生命 1.8~3.3s |
| 停留花瓣 | ≤ 3 片 | 防止遮挡人脸 |
| 运动模糊 | 3 帧历史 | Ring Buffer，透明度 0.12/0.20/0.30 |
| 录像码率 | 4 Mbps | 30fps，优先 MP4/AVC1 |
| DPR 上限 | WebGL 1.5x / 2D 2x | 平衡清晰度与性能 |
| 自动降级阈值 | FPS < 15 | 每次减少 8% 花瓣数 |

---

## 七、兼容性处理

| 场景 | 处理 |
|------|------|
| iOS Safari `ctx.filter` 不支持 | WebGL GPU 高斯模糊（两 pass 分离式 9-tap），三级降级链 |
| iOS Safari 权限链 | touchend + 串行请求 + initWithStream |
| 无摄像头 | 渐变背景降级（花瓣正常飘落） |
| 无陀螺仪 | 鼠标/触摸控制视角 |
| WebGL Context Lost | 2s 超时后自动重建 |
| 微信内置浏览器 | 视频/图片弹窗预览 + 长按保存 |
| 横屏方向 | 屏幕方向补偿（四元数旋转） |
| Safe Area（刘海屏） | `env(safe-area-inset-*)` |

---

## 八、迭代记录

### v4 — 性能优化 + 录像流畅度 + 视频保存 + 交互防护（2026-04-05）

> 上一版本 commit: `28402ac feat: WebGL GPU 高斯模糊后处理 + 拍照抗锯齿优化`

#### 改动概览

本次迭代聚焦于 **录像体验** 的三个核心问题，以及花瓣系统的多项优化：

| 文件 | 改动量 | 改动内容 |
|------|--------|---------|
| `js/capture.js` | +114 −29 | 录像性能优化、视频保存策略重构、录像中按钮禁用 |
| `js/particles.js` | +193 −97 | 花瓣贴图抗锯齿重写、涡流参数调优、人物距离感知停靠 |
| `js/app.js` | +10 −37 | 精简调试面板、录像中禁用摄像头切换 |
| `js/body-collision.js` | +8 −57 | 精简调试日志、清理冗余代码 |
| `css/style.css` | +7 −0 | 录像中摄像头按钮禁用样式 |

---

#### 问题 1：录像严重卡顿

**现象**：录像保存的视频一顿一顿的，花瓣动画不流畅。

**根因分析**：

录像合成循环（`_startCompositeLoop`）与主动画循环是两个独立的 `requestAnimationFrame`，叠加后每帧工作量翻倍。更关键的是，每帧合成时调用 3 次 `_drawBlurred()`（远/中/近景各一次），每次都要执行完整的 WebGL GPU 高斯模糊流水线：

```
纹理上传(texImage2D) → 水平 blur pass → 垂直 blur pass → readPixels 回读到 2D canvas
```

在手机上单次 blur 约 8-10ms，3 层共需 ~25-30ms，而 `captureStream(30)` 要求每帧只有 ~33ms 的预算。合成来不及时 `captureStream` 会重复最后一帧 → 多帧相同画面后突然跳到新画面 → 一顿一顿。

**技术难点**：
- 录像的帧率不取决于 rAF 频率，而取决于合成 canvas **实际被绘制**的频率
- `captureStream(fps)` 只控制编码器的采样率，不会主动驱动绘制
- 降低 captureStream fps 不解决问题（合成慢的话仍然卡）
- 隔帧合成（跳帧）反而更卡 —— 实际合成帧率变为 ~15fps，不如每帧都画但让每帧更快

**解决方案 — 录像时彻底跳过 blur**：

```javascript
// 录像时：直接 drawImage，完全跳过 WebGL blur
if (this.isRecording) {
  if (this.canvasFar.width > 0) {
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.drawImage(this.canvasFar, 0, 0, w, h);  // 直接绘制，不做 blur
    ctx.restore();
  }
  // ... 中景、近景同理
  return;  // 跳过运动模糊的历史帧叠加
}
```

| 方案 | 单帧合成耗时 | 等效帧率 | 效果 |
|------|------------|---------|------|
| 原方案（3×WebGL blur + 运动模糊） | ~30ms | ~15fps | 严重卡顿 |
| 中间方案（blur 半径减半 + 隔帧） | ~18ms | ~15fps | 仍然卡顿 |
| **最终方案（跳过 blur + 跳过运动模糊）** | **~3ms** | **~60fps** | **流畅** |

**为什么可以跳过 blur**：录像使用 1x DPR（合成 canvas = 屏幕像素），分辨率本身较低，1px 的 CSS blur 在 1x 画面上肉眼几乎不可见。运动模糊的 3 个历史帧 ring buffer 读写也可跳过（录像画面本身就有运动，不需要人工拖影）。

**内存影响**：无。提高合成帧率不增加内存 —— 内存开销只与 canvas 尺寸相关（已是 1x），跟帧率无关。

---

#### 问题 2：视频无法保存到相册

**现象**：iOS Safari 上录像完成后，视频无法保存到手机相册。

**根因分析**：

原方案对非微信环境使用 `<a download>` 下载 blob URL。但 **iOS Safari 不支持** blob URL 的 `<a download>` —— 它会直接在新标签页打开视频预览，播放完后视频就消失了，不会保存到相册。

```javascript
// ❌ 原方案：iOS Safari 上不生效
const a = document.createElement('a');
a.href = blobUrl;
a.download = 'video.mp4';
a.click();  // iOS: 打开新标签预览，不下载
```

**技术难点**：
- iOS Safari 的 `<a download>` 对 blob URL 无效（安全限制）
- 微信内置浏览器更严格，`<a download>` 完全不可用
- 需要兼容 iOS Safari / 微信 / Android Chrome / PC 四种环境

**解决方案 — Web Share API 优先 + 分级降级**：

```javascript
_saveRecording() {
  // 策略1：Web Share API（iOS 15+ / Android Chrome 均支持）
  if (navigator.canShare && navigator.share) {
    const file = new File([blob], filename, { type: mimeType });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: '花瓣雨' });
      return;
    }
  }
  // 策略2：降级
  this._fallbackSaveVideo(blob, filename);
}

_fallbackSaveVideo(blob, filename) {
  if (!isMobile) {
    // PC：<a download> 有效
    a.download = filename; a.click();
  } else {
    // 移动端：弹出视频预览弹窗，用户长按保存
    this._showVideoPreview(url, blob);
  }
}
```

| 环境 | 保存策略 | 用户体验 |
|------|---------|---------|
| iOS Safari 15+ | Web Share API → 系统分享面板 → 保存到相册 | 原生体验 |
| 微信内置浏览器 | 视频预览弹窗 → 长按保存 | 需用户操作 |
| Android Chrome | Web Share API → 系统分享面板 | 原生体验 |
| PC 浏览器 | `<a download>` 直接下载 | 直接保存 |

---

#### 问题 3：录像中摄像头翻转导致画面断裂

**现象**：录像过程中用户点击摄像头切换按钮，会导致视频流中断、画面闪烁。

**根因分析**：

`switchCamera()` 会停止当前摄像头 stream，请求新的 stream（前/后置切换），期间有 ~0.5-1s 的无画面间隙。而 `compositeCanvas` 的合成循环会持续读取 `video` 元素 —— 切换瞬间 `video.readyState < 2`，合成画面变成降级渐变背景，然后又恢复摄像头画面，造成明显的画面跳变。

**解决方案 — 三重保护**：

1. **事件层拦截**（`app.js`）：
```javascript
$btnSwitchCamera.addEventListener('click', () => {
  if (capture && capture.isRecording) return;  // 录像中直接跳过
  if (cameraModule) cameraModule.switchCamera();
});
```

2. **按钮视觉禁用**（`capture.js`）：
```javascript
startRecording() {
  // ...
  this._setCameraButtonsDisabled(true);  // 按钮变暗 + 禁止交互
}
stopRecording() {
  // ...
  this._setCameraButtonsDisabled(false);  // 恢复
}
```

3. **CSS 禁用样式**（`style.css`）：
```css
.ui-btn.ui-btn-disabled {
  opacity: 0.3;
  pointer-events: none;
  transform: none;
}
```

---

#### 优化 4：花瓣贴图 Alpha 边缘抗锯齿重写

**现象**：花瓣贴图在 WebGL 渲染时，边缘有硬锯齿或白色/黑色镶边（fringing）。

**根因分析**：

花瓣 PNG 贴图使用 **straight alpha**（未预乘），但 Three.js 在上传纹理时默认会做 `premultiplyAlpha`。对于半透明边缘像素（如 alpha=0.5, RGB=255），straight alpha 存储为 `(255, 200, 200, 128)`，premultiply 后变为 `(128, 100, 100, 128)`。但如果原始贴图的透明区域 RGB 不是纯黑（很多图片编辑器会保留白色 RGB），预乘后会导致边缘偏白/偏亮。

**解决方案 — CPU 侧 Alpha 边缘高斯平滑 + Edge-only 优化**：

```
原始贴图 → Canvas 解码 → 分离 RGBA 通道（线性空间）
  → Sobel 边缘检测（仅处理 alpha 梯度大的像素）
  → 3×3 高斯核平滑（只对边缘像素卷积）
  → 写回 Canvas → texImage2D 上传（straight alpha）
```

关键优化：**Edge-only processing** —— 通过 Sobel 算子先检测 alpha 通道的梯度，只对边缘像素做高斯平滑，内部像素直接跳过。对于 256×256 贴图，只有 ~5% 的像素需要卷积，大幅降低启动时的处理开销。

---

#### 优化 5：涡流参数调优

**现象**：涡流产生时花瓣上升过猛，长时间悬浮在空中不落下。

**调整**：

| 参数 | 旧值 | 新值 | 说明 |
|------|------|------|------|
| 涡流上升力 | `1.5 + intensity * 2.5` | `0.6 + intensity * 1.0` | 降低 60%，花瓣不再停滞 |
| 涡流冷却时间 | 0.5s | 1.5s | 避免连续触发多个涡流叠加 |

---

#### 优化 6：人物距离感知停靠花瓣缩放

花瓣停靠在人物身上时，根据人物距离（通过蒙版面积估算）微调花瓣大小：

```javascript
// 近处人物：花瓣稍大（更有存在感）；远处人物：保持原大小
const dist = this.bodyCollision.estimatedDistance;  // 0=很近, 1=远
const scaleMult = 1.0 + (1.0 - dist) * 0.6;       // 近→1.6×, 远→1.0×
p.scale = Math.min(p.scale * scaleMult, 1.2);      // 上限防过大
```

---

#### 优化 7：调试面板精简

清理了 `app.js` 动画循环中的大量调试信息（mesh 数量、Context 状态、四元数、UP 偏离角等），FPS 显示精简为 `FPS:30` 格式。调试面板和 FPS 计数器保持三击唤出机制。

`body-collision.js` 中移除了碰撞检测和涡流触发的 `console.log` 调试输出，减少生产环境日志噪音。

---

## 九、待实现方案：多品种花瓣切换

> **状态**：方案设计完成，待实现  
> **预计改动量**：中等（~200-300 行新代码）  
> **记录日期**：2026-04-05

### 1. 需求描述

支持多种花卉品种（樱花、杏花、梅花、玫瑰等），用户可在运行时自行切换。不同品种的花瓣在**贴图、形状、数量、运动轨迹**上有显著差异：

| 品种 | 花瓣特征 | 运动特征 |
|------|---------|---------|
| 樱花（当前默认） | 中等大小，圆润饱满 | 飘逸、螺旋旋转、优雅飘落 |
| 杏花 | 小而薄，花瓣多 | 落得快、翻转频繁、密密麻麻 |
| 梅花 | 花瓣少但大，厚实 | 慢悠悠、大幅飘荡、优雅 |
| 玫瑰 | 花瓣厚重，卷曲 | 重、落得快、几乎不飘 |

### 2. 架构方案

#### 2.1 品种配置系统（FLOWER_PRESETS）

在 `particles.js` 中新增集中式配置对象，所有品种相关参数归一管理：

```javascript
const FLOWER_PRESETS = {
  sakura: {
    name: '樱花',
    textures: ['sakura/1.png', 'sakura/2.png', ...],
    petalShapes: [{ w: 0.50, h: 0.35, bendX: 0.12 }],
    petalCount: 3000,
    fallSpeed: 6.0,
    swayAmplitude: [0.6, 2.1],
    spiralRadius: [0.3, 0.8],
    rotSpeed: { x: 1.2, y: 1.0, z: 0.6 },
    opacity: 0.95,
    roughness: 0.55,
    transmission: 0.05,
  },
  apricot: {
    name: '杏花',
    textures: ['apricot/1.png', ...],
    petalShapes: [{ w: 0.30, h: 0.25, bendX: 0.08 }],
    petalCount: 4000,     // 花瓣小但多
    fallSpeed: 9.0,       // 落得更快
    swayAmplitude: [0.3, 1.0],
    spiralRadius: [0.1, 0.4],
    rotSpeed: { x: 1.8, y: 1.5, z: 1.0 },
  },
  plum: {
    name: '梅花',
    textures: ['plum/1.png', ...],
    petalCount: 2000,
    fallSpeed: 4.5,
    swayAmplitude: [0.8, 2.5],
    spiralRadius: [0.5, 1.2],
    rotSpeed: { x: 0.8, y: 0.6, z: 0.4 },
  },
  rose: {
    name: '玫瑰',
    textures: ['rose/1.png', ...],
    petalCount: 1500,
    fallSpeed: 8.0,
    swayAmplitude: [0.2, 0.6],
    spiralRadius: [0.1, 0.3],
    rotSpeed: { x: 0.6, y: 0.5, z: 0.3 },
  },
};
```

#### 2.2 核心运动参数差异对照

| 参数 | 樱花 | 杏花 | 梅花 | 玫瑰 |
|------|------|------|------|------|
| 花瓣数量 | 3000 | 4000（小而密） | 2000（少而雅） | 1500（厚重） |
| 下落速度 | 6.0 | 9.0（快） | 4.5（慢） | 8.0（重） |
| 横向摆幅 | 0.6~2.1 | 0.3~1.0（窄） | 0.8~2.5（飘） | 0.2~0.6（直落） |
| 螺旋半径 | 0.3~0.8 | 0.1~0.4 | 0.5~1.2 | 0.1~0.3 |
| 翻转频率 | 1.2x | 1.8x（频繁） | 0.8x（优雅） | 0.6x（缓慢） |
| 远景占比 | 48% | 60%（密密麻麻） | 35% | 40% |
| 花瓣尺寸范围 | 0.08~1.30 | 0.05~0.80（小） | 0.10~1.50（大） | 0.15~1.00 |

#### 2.3 切换逻辑

```javascript
// particles.js 新增
switchFlowerType(presetKey) {
  const preset = FLOWER_PRESETS[presetKey];
  if (!preset) return;
  this.currentPreset = presetKey;
  this.fallSpeed = preset.fallSpeed;
  this.layerConfig = preset.layerConfig;
  // ... 更新所有运动参数
  // 重新加载贴图 → 重建材质 → 重建 InstancedMesh
  this._loadPetalAssets();
}
```

#### 2.4 UI 选择器

底部添加花瓣品种选择圆钮（类似滤镜选择器）：

```
[樱花] [杏花] [梅花] [玫瑰]
```

### 3. 改动范围评估

| 文件 | 改动量 | 内容 |
|------|--------|------|
| `js/particles.js` | +120~150 行 | 品种配置对象 + 切换/重建逻辑 |
| `index.html` | +10~20 行 | 品种选择器 UI 元素 |
| `css/style.css` | +30~40 行 | 选择器样式 |
| `js/app.js` | +10~20 行 | 选择器事件绑定 |
| 新增贴图资源 | 每种花 4~8 张 PNG | 目录：`textures/sakura/`、`textures/apricot/` 等 |

### 4. 性能影响评估

| 方面 | 影响 | 说明 |
|------|------|------|
| 运行帧率 | 无影响 | 切换后粒子系统结构不变，仅参数不同 |
| 内存 | 切换瞬间有峰值 | 旧纹理释放 + 新纹理加载，同一时刻只有一套材质 |
| 切换延迟 | ~0.5-1s | 主要是贴图加载 + alpha 柔化处理时间 |
| 杏花模式（4000 粒子） | 帧率略降 | 比默认 3000 多 33%，InstancedMesh 批量渲染影响不大 |

**预加载优化**：启动时可后台预加载所有品种贴图，切换时只需重建 InstancedMesh（~50ms），用户感知不到延迟。

### 5. 切换过渡方案

避免"花瓣突然消失再出现"的突兀感：

- **方案 A（推荐）**：旧花瓣加速下落消失（~1s），新花瓣从上方飘入
- **方案 B**：全局淡出旧花瓣（opacity → 0，~0.5s），淡入新花瓣

### 6. 资源管理注意事项

- 初始只加载当前品种贴图，其他品种按需加载或后台预加载
- 切换时 `dispose()` 旧纹理释放 GPU 显存
- 每种花需准备 4~8 张透明背景 PNG 贴图（不同角度、不同开合度）
- 贴图是最大工作量，需要美术资源支持

### 7. 流程图

```
用户点击品种按钮
    ↓
读取 FLOWER_PRESETS[key]
    ↓
贴图已缓存? ──否──→ 加载贴图 + Alpha 柔化
    │                       │
    是                      ↓
    │←──────────────── 缓存材质
    ↓
更新运动参数 (fallSpeed / sway / spiral / rotSpeed)
    ↓
重建 InstancedMesh (dispose 旧 mesh → 创建新 mesh)
    ↓
过渡动画 (旧花瓣加速下落 / 新花瓣从上方飘入)
```

---

## 附录：部署问题与解决指南

### 1. CDN 同名文件不更新（skip 问题）

**现象**：更新了花瓣贴图 `1.png~8.png`，重新部署后正式环境仍然是旧图，日志显示 `[skip]`。

**原因**：部署脚本（tupload）检测到 CDN 上已存在同名文件，自动跳过上传。

**解决**：**重命名文件**让 CDN 认为是新文件。例如将 `1.png~8.png` 改为 `p1.png~p8.png`，同时更新 JS 中的引用路径：

```javascript
// js/particles.js、js/particles-v7.js、js/resting-petals.js 中的贴图路径
this.petalTexturePaths = [
  'p1.png', 'p2.png', 'p3.png', 'p4.png',
  'p5.png', 'p6.png', 'p7.png', 'p8.png'
];
```

### 2. 视频（mp4）上传到正式环境

**现象**：部署脚本只处理图片（png/jpg/gif/svg/webp/ico）、CSS、JS 文件，**不会上传 mp4 视频文件**，也不会替换 HTML 中 mp4 的相对路径。

**解决**：使用 `expect` 脚本包装 `tupload2` 命令行工具手动上传。tupload2 有交互式确认提示，直接管道输入会导致 readline 崩溃，必须用 `expect` 处理：

```bash
# 上传视频到正式环境 CDN
cd .codebuddy/skills/page-deploy

expect -c '
set timeout 30
spawn ./node_modules/.bin/tupload2 \
  /Users/yanli/Downloads/flowers/start.mp4 \
  start.mp4 \
  --token <TUPLOAD_TOKEN> \
  --baseurl /qqcdn/redian/petals_fall \
  --site mat1.gtimg.com
expect "确定*"
send "Y\r"
expect eof
'

# 验证上传结果
curl -sI "https://mat1.gtimg.com/qqcdn/redian/petals_fall/start.mp4" | head -3
# 应该返回 HTTP/2 200
```

上传成功后，在 HTML 中使用绝对 CDN 路径：
```html
<source src="https://mat1.gtimg.com/qqcdn/redian/petals_fall/start.mp4" type="video/mp4">
```

> ⚠️ **注意**：正式环境资源路径是 `petals_fall/`，测试环境是 `petals_fall_test/`。正式链接**不能**引用测试环境资源，测试 CDN 在公司网络外不可访问。

### 3. 移动端视频自动播放

**现象**：开始页背景视频在手机上需要点击才能播放。

**原因**：移动端浏览器限制自动播放，需满足 `muted + playsinline + autoplay`，并在 JS 中主动调 `play()`。

**解决**：

HTML 标签加完整兼容属性：
```html
<video autoplay muted loop playsinline
       webkit-playsinline
       x5-video-player-type="h5-page"
       x5-video-player-fullscreen="true">
```

JS 中多时机尝试播放（立即、loadedmetadata、canplay、DOMContentLoaded、load、touchstart），确保尽早播放。

### 4. 微信浏览器摄像头不可用

**现象**：微信内打开页面后无法启用摄像头。

**原因**：微信内置浏览器对 `getUserMedia` API 有限制，需要域名在微信公众平台配置 **JS 安全域名**。

**当前处理**：
- 代码中已做三级降级：后置→前置→无约束 `{video: true}`
- 增加了旧版 `navigator.getUserMedia` API 兼容
- 摄像头不可用时自动显示渐变背景降级方案

### 5. 正式环境与测试环境资源差异

**现象**：两个环境花瓣效果不一致。

**根因**：首次部署正式环境时上传了旧版贴图，后来更新贴图后因同名被 skip，导致正式环境停留在旧版。

**排查方法**：
```bash
# 对比同一文件在两个环境的大小/etag
curl -sI "https://mat1.gtimg.com/qqcdn/redian/petals_fall/p1.png" | grep content-length
curl -sI "https://mat1.gtimg.com/qqcdn/redian/petals_fall_test/p1.png" | grep content-length
```

**预防**：每次更新资源后，如果文件名不变，**必须重命名文件**再部署。

### 6. 部署环境一览

| 环境 | HTML 地址 | CDN 资源路径 |
|------|-----------|-------------|
| 测试 | `https://testqqnews.qq.com/qqfile/redian/petals_fall.html` | `https://mat1.gtimg.com/qqcdn/redian/petals_fall_test/` |
| 正式 | `https://h5.news.qq.com/qqfile/redian/petals_fall.html` | `https://mat1.gtimg.com/qqcdn/redian/petals_fall/` |

**部署命令**：
```bash
# 测试环境
node .codebuddy/skills/page-deploy/scripts/deploy.cjs /path/to/flowers petals_fall test --title-checked

# 正式环境（需二次确认）
node .codebuddy/skills/page-deploy/scripts/deploy.cjs /path/to/flowers petals_fall production --title-checked --confirmed
```

---

## 七、花瓣贴图损坏问题修复记录（2026-04-06）

### 1. 问题现象

花瓣纹理在渲染时呈现明显的**横条纹**和模糊失真，与原始花瓣照片差异巨大。

### 2. 根因分析

问题由以下操作链条叠加导致：

| 步骤 | 操作 | 结果 |
|------|------|------|
| ① | 花瓣边缘有锯齿/白边（straight alpha + premultiplyAlpha 冲突） | 编写 `_softenTextureAlpha()` 运行时修复 |
| ② | 尝试将运行时处理结果导出为静态图 | 导出过程异常，产生横条纹损坏图 |
| ③ | CDN 同名文件跳过（`1.png` 已存在） | 需要改名为 `p1.png` ~ `p8.png` 上传 |
| ④ | 损坏的处理结果被保存为 `p1.png` ~ `p8.png` | 项目开始使用损坏贴图 |
| ⑤ | `_softenTextureAlpha()` 继续对已损坏的图做 3轮 7×7 高斯模糊 | **双重损坏**：损坏图再被模糊 |

核心问题：`p1.png` ~ `p8.png` **不是原始图片改名，而是经过 `_softenTextureAlpha` 处理后错误导出的产物**（2倍上采样 → 颜色扩展 → 3轮7×7高斯模糊），导出时出现横条纹。原始高清图被备份为 `1_backup.png` ~ `8_backup.png`，但未被引用。

### 3. 修复方案

**三步修复**：

1. **恢复原始贴图**：用 `1_backup.png` ~ `8_backup.png`（原始高清图）覆盖损坏的贴图
2. **重命名绕过 CDN 缓存**：改名为 `petal1.png` ~ `petal8.png`（CDN 同名文件会 skip）
3. **禁用过度模糊**：移除 `_softenTextureAlpha()` 调用，原始高清图配合 `premultiplyAlpha: true` 即可正确处理边缘

### 4. 代码变更

```javascript
// 贴图路径（修改前）
this.petalTexturePaths = [
  'p1.png', 'p2.png', 'p3.png', 'p4.png',
  'p5.png', 'p6.png', 'p7.png', 'p8.png'
];

// 贴图路径（修改后）
this.petalTexturePaths = [
  'petal1.png', 'petal2.png', 'petal3.png', 'petal4.png',
  'petal5.png', 'petal6.png', 'petal7.png', 'petal8.png'
];

// 纹理加载回调中移除了 this._softenTextureAlpha(texture) 调用
```

### 5. 经验教训

- **CDN 同名覆盖问题**：tupload CDN 对同名文件会 `[skip]`，更新资源时**必须更换文件名**
- **避免运行时重度图像处理**：3轮 7×7 高斯模糊在 CPU 侧开销大且容易引入错误，应在离线工具中预处理
- **保留原始素材**：备份文件 `*_backup.png` 在此次修复中起到了关键作用

---

## 八、PC 端人物残影修复（2026-04-06）

### 1. 问题现象

PC 端浏览器中，人物移动时 `canvas-person`（人物遮罩层）出现明显残影——旧位置的人物轮廓残留在画面上。

### 2. 根因分析

两个叠加因素：

| 因素 | 说明 |
|------|------|
| **旧蒙版 + 新视频帧错配** | 非分割帧用 `lastMask`（旧蒙版）+ 当前 `video`（新视频帧）做 `source-in` 合成，人物已移动但蒙版未更新 → 旧位置残留像素 |
| **蒙版边缘非纯黑** | MediaPipe 蒙版用 RGB 亮度表示置信度（白=人物、黑=背景），边缘有 RGB 50~120 的半透明区域，`source-in` 后这些像素不是完全透明 |

### 3. 修复方案（segmentation.js v3）

1. **不再重绘旧蒙版**：非分割帧和等待推理时直接 `return`，保持上次绘制结果不变。canvas 上永远是同一帧蒙版 + 同一帧视频的匹配组合
2. **RGB 亮度阈值二值化**：在 480px 低分辨率中间 canvas 上做 `brightness < 128 → RGBA 全清零`，消除边缘半透明残留
3. **PC 端分割频率提升**：`frameSkip` 从 2 改为 1（每帧都发送分割请求）

### 4. 之前阈值方案未生效的原因

首次修复对 **alpha 通道**做阈值（`data[i+3] < 80`），但 MediaPipe 蒙版的 alpha 全是 255，阈值永远不触发。修正为对 **RGB 亮度**做阈值后生效。

---

## 九、FPS 显示彻底移除（2026-04-06）

### 问题

录像时右上角出现 `FPS:20` 显示。原因：三击唤出 FPS 的 `document.addEventListener('touchend')` 监听器在录像按钮点击时也会触发计数。

### 修复

- 删除三击唤出 FPS/调试面板的机制（`touchend` + `click` 监听器）
- 删除动画循环中的 FPS 文本更新
- FPS 计数器和调试面板永远 `display:none`

---

## 十、拍照/录像保存功能重构（2026-04-06）

### 1. 问题汇总

| 环境 | 问题 |
|------|------|
| 微信个人版 | `wx.previewImage` 依赖 JS-SDK 初始化（未做），`<a download>` 跳空白页 |
| 企业微信 | 长按图片不触发保存菜单，`<a download>` 可能无效 |
| 其他移动浏览器 | share 不支持时直接弹"截屏录制"提示，不合理 |
| 所有移动端 | 点"保存"到弹窗等待很久（3x DPR 提升 + 运动模糊预缓存 + PNG 导出） |

### 2. 统一优先级链

所有环境走同一套降级链，不再按环境分支：

```
优先级 1：navigator.share({ files }) → 保存到相册（最优）
    ↓ 不支持或失败
优先级 2：<a download> → 保存到手机文件（次优）
    ↓ 微信个人版不可用（跳空白页）
优先级 3：弹预览 + 操作指引 → 兜底
```

### 3. 各环境实际行为

| 环境 | 照片 | 视频 |
|------|------|------|
| iOS Safari | `share` → 系统面板保存相册 | `share` → 系统面板保存相册 |
| Android Chrome | `share` → 系统面板保存相册 | `share` → 系统面板保存相册 |
| 企业微信 | 尝试 `share` → 成功则系统面板；失败则 `<a download>` | 同左 |
| PC 浏览器 | 尝试 `share` → 失败则 `<a download>` 直接下载 | 同左 |
| 其他移动浏览器 | 尝试 `share` → 失败则 `<a download>` | 同左 |
| 微信个人版 | `share`/`download` 均失败 → 弹全屏 `<img>` 长按保存 | `share`/`download` 均失败 → 弹 `<video>` 播放 + 提示用浏览器打开 |

### 4. 移动端拍照性能优化

| 优化项 | 改动 | 效果 |
|--------|------|------|
| DPR 不提升 | 移动端保持 2x，不提升到 3x | 合成 canvas 面积减少 56% |
| 跳过运动模糊预缓存 | 移动端不执行 `_preloadMotionBlurHistory()` | 省去 3 次 WebGL blur ~30ms |
| JPEG 导出 | 移动端 `toBlob('image/jpeg', 0.92)` 代替 PNG | blob 从 ~8MB 降到 ~500KB |

综合效果：移动端拍照从点击到弹出预览快 3-5 倍。
