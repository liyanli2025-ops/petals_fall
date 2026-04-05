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
