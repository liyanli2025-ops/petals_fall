# 花开地图 H5 — 问题汇总与分析

## 当前所有问题

---

### 问题 1：花瓣滑动错位

**现象**：滑动页面时，Canvas 上的花瓣和页面内容不同步，花瓣会先跟着屏幕走，然后跳回正确位置。

**根本原因**：Canvas 使用 `position: fixed`，花瓣用页面坐标存储，绘制时通过 `p.y - window.pageYOffset` 转换为视口坐标。但在手机浏览器（尤其 iOS Safari/微信）中，**页面滚动由合成线程（compositor thread）异步执行**，而 `requestAnimationFrame` 回调在主线程执行时拿到的 `pageYOffset` **滞后于实际渲染的滚动位置**——两者差 1~3 帧。这导致花瓣总是比页面内容"慢半拍"。

**尝试过的方案及失败原因**：
1. **absolute + 全页高度 Canvas**：Canvas 跟随页面滚动，零错位。但 iOS 限制 Canvas 最大尺寸为 4096×4096 像素，页面高度 3900px × dpr=2 = 7800px 超出限制，导致长沙以下花瓣被截断。
2. **absolute + 滑动窗口**：Canvas 只有 2 倍视口高，随滚动动态移动 `style.top`。看起来好一些，但 `style.top` 的更新本身也是主线程操作，仍有微小延迟，且每次更新 top 会触发 layout，反而增加卡顿。同时 Canvas `style.height` 撑高了 map-container，导致底部出现大量空白。
3. **fixed + scrollY 偏移（当前）**：滚动最流畅（不触碰 DOM），但 scrollY 异步滞后导致花瓣错位。

**正确解决方案**：
- **方案 A（推荐）**：放弃 Canvas 粒子系统，改用 **DOM 元素（div + img）+ CSS transform** 做花瓣。DOM 元素天然跟随页面滚动，零错位。绽放时创建若干 `<div class="canvas-petal">` 元素放在 `map-container` 内，用 CSS animation 或 JS 控制 transform 做飘散动画。性能足够——每城市仅 10~20 个花瓣 DOM，比 Canvas 30fps 全屏重绘更轻量。
- **方案 B**：Canvas 用 `position: absolute`，高度覆盖整个页面，但 **dpr 限制为 1**（不做高清缩放），这样 375×3900 不超过 4096。花瓣可能略微模糊，但零错位。

---

### 问题 2：滑动卡顿

**现象**：手机上滑动页面有明显阻力感，不流畅。

**根本原因**：
1. ~~`.city-aura` 使用 `box-shadow: 0 0 80px 60px`~~（**已修复**，改为 `radial-gradient`）
2. ~~`.bloom-glow` 使用 `box-shadow: 0 0 40px 30px`~~（**已修复**，改为 `radial-gradient`，动画改为播 3 次）
3. **Canvas 的 `requestAnimationFrame` 30fps 循环**：即使滚动时也在主线程执行 `clearRect` + `drawImage` × N 个粒子，与浏览器合成线程争抢资源。

**已完成的优化**：
- city-aura: box-shadow → radial-gradient ✅
- bloom-glow: box-shadow → radial-gradient，infinite → 播 3 次 ✅

**仍需做的优化**：
- 如果采用方案 A（DOM 花瓣），Canvas 完全移除，卡顿彻底解决
- 如果保留 Canvas，应在滚动时暂停 `updateParticles()`（物理计算），且跳过 `drawImage`，只做 `clearRect`

---

### 问题 3：花瓣残影（留痕）未生效

**现象**：花瓣全部消失后页面显得空，期望保留少量花瓣以极低透明度"留痕"。

**当前代码状态**：`updateParticles()` 中有 ghost 逻辑（粒子 life≤0 时 30% 概率转为 ghost，每城市最多 5 片，alpha 0.06~0.15）。`drawParticles()` 中也有 ghost 渲染逻辑。**代码逻辑本身是正确的**。

**为什么看不到效果**：
- ghost 花瓣的 alpha 只有 0.06~0.15，在浅色背景上几乎不可见
- 如果花瓣图片（`petalImg`）本身有透明区域，再乘以 0.1 的 alpha，可能完全看不出来
- Canvas fixed 模式下，ghost 花瓣的 `p.y - scrollY` 可能已经超出视口范围（因为页面滚走了），所以被视口裁剪跳过了

**解决方案**：
- 提高 ghost alpha 到 0.15~0.30
- 或者改用 DOM 方案：绽放结束后在花朵周围创建几个 `<img>` 元素，opacity 0.15~0.25，永久留在页面上。这些 DOM 元素天然跟随页面滚动，不存在裁剪问题。

---

### 问题 4：进度条位置不对

**现象**：右侧进度条的填充进度和实际滚动位置不匹配。

**根本原因**：进度条的填充只在城市绽放时更新（`updateProgress(idx)` 按绽放城市数 / 总城市数计算百分比），**不跟随滚动位置实时更新**。用户预期的是"滑到哪里进度条就到哪里"，但实际只有触发绽放时才跳一下。

**解决方案**：添加 `scroll` 事件监听，根据当前 scrollTop / 总滚动高度 实时更新 `progress-fill` 的 height。

---

### 问题 5：浮层背后可滚动

**现象**：打开花事详情浮层后，背后的地图页面仍可滑动。

**当前状态**：已用三层防御（html+body overflow:hidden + document touchmove preventDefault + CSS touch-action:none）。**但 `.spot-body` 的 `touch-action: pan-y` 被我加在了 CSS 里但后来在最后一版中漏掉了**（检查发现确实不在最新 CSS 中）。

**解决方案**：确认 CSS 中 `.spot-body` 有 `touch-action: pan-y`（当前已有）。JS 中的 document 级 touchmove 拦截逻辑是正确的，但需要确保 `_overlayOpen` 状态在打开/关闭时正确切换。

---

### 问题 6：北京比哈尔滨先绽放

**现象**：开屏消失后，北京的花先于哈尔滨绽放。

**根本原因**：`dismissIntro()` 中 `state.introVisible = false` 立即执行，但哈尔滨的主动绽放在 1000ms 后才触发。在这之间 IntersectionObserver 可能检测到北京进入视口，由于 `introVisible` 已为 false，北京可以绽放。

**当前已修复**：已添加严格顺序限制 `if (index > 0 && !state.bloomedCities[index - 1])` ✅

---

### 问题 7：旧的 createPetalWatermarks 已删除但未替代

**现象**：原来的 DOM 水印方案（`createPetalWatermarks`）已被删除，说改用 Canvas ghost 方案，但 ghost 实际上看不到（见问题 3）。

**解决方案**：要么恢复 DOM 水印方案（效果确定、不依赖 Canvas），要么修复 ghost 方案让其可见。

---

## 总结：推荐修复优先级

| 优先级 | 问题 | 推荐方案 |
|--------|------|----------|
| P0 | 花瓣错位 | 改用 DOM 花瓣方案 或 Canvas absolute + dpr=1 |
| P0 | 滑动卡顿 | 去掉 Canvas rAF 循环（如果用 DOM 方案则自动解决）|
| P1 | 花瓣残影 | 恢复 DOM 水印方案 createPetalWatermarks |
| P1 | 进度条 | 添加 scroll 监听实时更新 |
| P2 | 浮层背后滚动 | 当前方案基本可用，微调 |
| ✅ | 绽放顺序 | 已修复 |
| ✅ | box-shadow 性能 | 已改为 radial-gradient |
