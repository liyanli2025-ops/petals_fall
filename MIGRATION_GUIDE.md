# 花瓣雨 AR 全息 — WebGL Context 合并改造指南

## 问题背景

在手机浏览器（尤其 iOS Safari）中，同一页面可用的 WebGL context 数量有限（通常 2-4 个）。当超出限制时，浏览器会**静默回收**最早创建的 context，导致对应 canvas 变成空白。

### 原始架构（v9）：4 个 WebGL Context

| Context | Canvas | 用途 | CSS |
|---------|--------|------|-----|
| WebGL #1 | `canvas-far` | 远景花瓣（dust/veryFar/far） | `filter: blur(1px)` |
| WebGL #2 | `canvas-mid` | 中景花瓣（midFar/mid/midNear） | 无（清晰） |
| WebGL #3 | `canvas-near` | 近景花瓣（near/veryNear） | `filter: blur(4px)` |
| WebGL #4 | MediaPipe 内部 | SelfieSegmentation 人体分割 | — |

**症状**：摄像头启动后，MediaPipe 创建第 4 个 WebGL context，浏览器回收 `canvas-mid` 的 context → 中景花瓣消失（占总量 32% 的主要可见花瓣）。

### 改造后架构（v11）：2 个 WebGL Context

| Context | Canvas | 用途 |
|---------|--------|------|
| WebGL #1 | `canvas-petals`（隐藏） | **所有**花瓣的 3D 渲染 |
| WebGL #2 | MediaPipe 内部 | SelfieSegmentation 人体分割 |

景深效果通过 **1 个 WebGL renderer 做 3 pass 渲染**，每 pass 的结果通过 `drawImage` 复制到对应的 2D canvas，再由 CSS `filter: blur()` 实现模糊。

## 核心改造内容

### 1. HTML 层级结构

```
canvas-petals   (隐藏, WebGL 渲染目标)
canvas-far      (2D, z-index:1, CSS blur 1px)
canvas-person   (2D, z-index:2, 人物遮罩)
canvas-mid      (2D, z-index:3, 清晰)
canvas-near     (2D, z-index:5, CSS blur 4px)
```

### 2. particles.js — 单 WebGL + 三层分渲

**关键变化**：

- **1 个隐藏的 WebGL canvas** 作为渲染目标（`display: none`）
- **3 个 2D canvas** 作为显示层（带 CSS blur）
- InstancedMesh 按**渲染层**（far/mid/near）分组，不再按材质分组
- 每帧做 3 次 `renderer.render()`，每次只显示（`mesh.visible`）对应层的 mesh
- 每次 render 后立即 `drawImage(webglCanvas)` 到对应 2D canvas

```javascript
// 3-pass 渲染核心逻辑
for (const renderKey of ['far', 'mid', 'near']) {
  // 只显示当前层的 mesh
  for (const rk of ['far', 'mid', 'near']) {
    for (const m of renderMeshes[rk]) m.visible = (rk === renderKey);
  }
  renderer.render(scene, camera);
  // 复制到 2D 显示 canvas
  displayLayers[renderKey].ctx.drawImage(webglCanvas, 0, 0, dw, dh);
}
```

### 3. Context Lost 恢复机制

```javascript
// 事件监听
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();         // 请求浏览器恢复
  _contextLost = true;
  setTimeout(forceRecreate, 2000);  // 保险：2s 后强制重建
});

canvas.addEventListener('webglcontextrestored', () => {
  forceRecreateRenderer();    // 完全重建 renderer + mesh
});

// 每帧轮询（某些浏览器不触发事件）
if (gl.isContextLost()) { ... }
```

`_forceRecreateRenderer` 完全销毁旧 renderer，创建新的，重新上传所有贴图/几何体/实例矩阵。

### 4. z-index 层级与人物遮罩

**关键发现**：`canvas-person`（人物遮罩）使用 `source-in` 合成模式绘制视频帧的人物区域。但由于 MediaPipe 蒙版的非人物区域不是纯透明的，`canvas-person` 实际上会覆盖它下面的所有内容。

**解决方案**：调整 z-index，让中景和近景花瓣在人物遮罩**之上**：

| 层 | z-index | 被人物遮挡？ |
|----|---------|-------------|
| camera-video | 1 | — |
| canvas-far | 1 | ✅ 远景在人物后面 |
| canvas-person | 2 | — |
| canvas-mid | 3 | ❌ 中景在人物前面 |
| canvas-near | 5 | ❌ 近景在人物前面 |

## 踩坑记录

### 踩坑 1：以为是 Context Lost，实际是 z-index 遮挡

**症状**：花瓣"一闪就没"。

**误判**：以为是 MediaPipe 创建第 2 个 WebGL context 时回收了花瓣的 context。花了大量时间实现 context lost 恢复机制。

**真相**：诊断面板显示 WebGL 完全正常（FPS:60, GL:✓, 无 CTX LOST）。实际是 `canvas-person`（z-index:4）把花瓣 `canvas-petals`（z-index:2）完全遮挡了。MediaPipe 第一次 `onResults` 回调后开始绘制 `canvas-person`，花瓣就被盖住了。

**教训**：遇到"渲染消失"问题，先加诊断面板确认 WebGL 状态，再用测试方块验证 canvas 可见性。不要假设 Context Lost。

### 踩坑 2：预热 MediaPipe 导致初始化失败

**症状**：花瓣彻底没有了。

**原因**：尝试在 `particles.init()` 之前预热 MediaPipe 的 `send()`，但 `send()` 抛异常被外层 try-catch 捕获，导致 `particles.init()` 根本没执行。

**教训**：不要在关键初始化路径中加入可能失败的异步操作。

### 踩坑 3：2D Canvas 分辨率不匹配 WebGL

**症状**：花瓣全部模糊。

**原因**：WebGL canvas 用 `setPixelRatio(2)` 渲染（实际像素 = 逻辑像素 × 2），但 2D 显示 canvas 的 width/height 只设了逻辑像素。高分辨率图像被缩小再被 CSS 放大 → 模糊。

**修复**：`canvas.width = innerWidth * dpr`。

### 踩坑 4：3-pass 渲染性能影响

**症状**：花瓣数量明显减少。

**原因**：每帧 3 次 `renderer.render()`，GPU 负载 ×3，FPS 下降到 15 以下，触发了 `autoTunePerformance()` 自动裁剪花瓣。

**缓解**：WebGL pixelRatio 从 2 降到 1.5。

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `index.html` | 3 个 WebGL canvas → 1 个隐藏 WebGL + 3 个 2D canvas |
| `css/style.css` | z-index 层级调整，保留原始 CSS blur |
| `js/particles.js` | 完全重写：单 renderer + 3-pass 渲染 + context 恢复 |
| `js/capture.js` | 合成逻辑适配三层 2D canvas |
| `js/app.js` | 初始化顺序调整 + 诊断面板 |
| `js/segmentation.js` | 无改动 |

## 性能对比

| 指标 | v9（3 WebGL） | v11（1 WebGL + 3 pass） |
|------|--------------|------------------------|
| WebGL Context 数 | 4（含 MediaPipe） | 2（含 MediaPipe） |
| Context Lost 风险 | 高（4 > 手机限制） | 低（2 安全） |
| GPU draw call/帧 | 3 次 render | 3 次 render |
| CSS 景深效果 | ✅ blur(1px) + blur(4px) | ✅ 相同 |
| 人物遮挡花瓣 | ✅ 远+中景被遮挡 | ✅ 仅远景被遮挡 |
| 拍照/录像 | ✅ 三层合成 | ✅ 三层合成 |

## 成像花瓣边缘修复（Defringe）

### 问题

花瓣素材（petal1~8.png）在抠图时，边缘的半透明像素（alpha 1~200）混入了深色背景的 RGB，导致成像时中景层花瓣有一圈明显的深色/暗红色边。

这个问题在行业中叫 **premultiplied alpha 边缘污染（color bleeding / matting fringe）**，等价于 Photoshop 的「去边 / Defringe」操作。

### 为什么只改成像，不改实时预览

1. **性能**：defringe 需要逐像素扫描 + 5×5 邻域搜索，对整个 canvas 做一次约需 5-15ms。实时预览 60fps 下每帧只有 16ms 预算，加入会导致掉帧。
2. **感知差异**：实时预览中花瓣在运动，深色边不易察觉；成像（拍照/录像）是静态画面，边缘瑕疵会被放大审视。
3. **风险隔离**：不改动实时渲染路径，避免引入新的视觉问题或性能回退。

### 算法原理

```
对每个边缘像素（alpha 在 1~200，且 5×5 邻域中有 alpha < 10 的透明像素）：
  1. 在 5×5 邻域中找到所有 alpha > 200 的「内部不透明」像素
  2. 计算这些内部像素的平均 RGB
  3. 用平均 RGB 替换当前边缘像素的 RGB
  4. alpha 保持不变（保留原始的透明度过渡）
```

做 2 轮迭代：第一轮修复最外层边缘，第二轮搜索范围扩大（5×5 → 7×7）修复更深层的污染像素。

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 处理位置 | `capture.js` 合成时 | 不影响实时预览性能 |
| 只处理 mid 层 | ✅ | far 层有 CSS blur 遮盖，near 层也有 blur，只有 mid 层是清晰渲染 |
| alpha 不修改 | ✅ | 避免锯齿、保留自然过渡 |
| 离屏 canvas 复用 | ✅ | `_defringeCanvas` 懒初始化 + 尺寸匹配复用，避免每帧创建 |
| 2 轮迭代 | ✅ | 单轮可能遗漏深层污染像素，3 轮以上性能收益递减 |

### 文件改动

| 文件 | 改动 |
|------|------|
| `js/capture.js` | 新增 `_defringeMid()` 方法；`_composite()` 和 `_preloadMotionBlurHistory()` 中 mid 层使用 defringe 处理后的 canvas |

## 录像黑屏 & 模糊丢失修复

### 踩坑 5：录像预览黑屏（两个循环抢画布）

**症状**：录完视频后弹出预览，画面全黑。保存下来的视频也是黑的。之前（v9 架构）正常，改成 v11（单 WebGL + 3 个 2D canvas）后出现。

**原因**：`_startCompositeLoop()`（录像合成）和 `particles.update()`（花瓣动画）各自跑独立的 `requestAnimationFrame` 循环。两个循环不同步：

1. 花瓣动画 `update()` 做 3-pass 渲染，把 WebGL 内容 `drawImage` 到 `canvasFar/canvasMid/canvasNear`
2. 录像合成 `_composite()` 从 `canvasFar/canvasMid/canvasNear` 读取内容合成视频帧

当录像合成去读的时候，花瓣动画可能刚好在 `clearRect` 准备画下一帧，导致读到空白内容 → 黑屏。

**修复**：删掉独立的 `_startCompositeLoop()`，改为在 `particles.js` 的 `update()` 末尾（3-pass 渲染完成后）同步调用 `captureManager.onFrameReady()`。这样合成时 2D canvas 一定有内容。

```javascript
// particles.js — 3-pass 渲染完成后
if (this.captureManager && this.captureManager.isRecording) {
  this.captureManager.onFrameReady();
}
```

```javascript
// capture.js — 新增同步合成入口
onFrameReady() {
  if (!this.isRecording) return;
  this._composite();
}
```

**教训**：涉及多个 canvas 的读写时序时，不能用独立的 `requestAnimationFrame` 循环分别操作。必须在同一帧的同一个同步执行块内完成"写 → 读"。

### 踩坑 6：录像保存后模糊花瓣消失

**症状**：录像预览不再黑屏了，但保存下来的视频里远景和近景的模糊花瓣消失了，只有中景的清晰花瓣。

**原因**：录像分支为了"避免 WebGL 黑帧"使用了简化版模糊（`_drawScaleBlur` + `_drawSoftScaleBlur`），效果远不如拍照时的 `_drawBlurred`（WebGL 高斯模糊）。简化版的模糊半径太小（`blurRadius=1.5`），在 1x DPR 的录像 canvas 上几乎看不出效果。

**修复**：黑屏问题已通过同步合成解决，录像时不再需要回避 WebGL 模糊。直接统一使用 `_drawBlurred` 方法：

| 花瓣层 | 修复前（录像） | 修复后（录像） | 拍照 |
|--------|---------------|---------------|------|
| 远景 far | `_drawScaleBlur(1.5)` ≈ 几乎无效 | `_drawBlurred(2.5 * DPR)` | `_drawBlurred(2.5 * DPR)` |
| 近景 near | `_drawSoftScaleBlur` ≈ blur(3px) | `_drawBlurred(4 * DPR)` | `_drawBlurred(4 * DPR)` |

**教训**：录像画质不能比拍照降级。用户保存的视频会被反复观看和分享，质量差会直接影响体验。性能优化应该在不影响最终产出物的前提下进行。

### 文件改动

| 文件 | 改动 |
|------|------|
| `js/capture.js` | 删除 `_startCompositeLoop()` 独立循环，新增 `onFrameReady()` 同步入口；录像分支改用 `_drawBlurred` 完整模糊 |
| `js/particles.js` | `update()` 末尾新增 `captureManager.onFrameReady()` 调用 |
| `js/app.js` | 双向绑定 `particles.captureManager = capture` |
