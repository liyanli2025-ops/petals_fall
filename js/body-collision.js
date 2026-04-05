/**
 * 人体碰撞检测模块
 * 
 * 基于 SelfieSegmentation 蒙版提取人物轮廓，
 * 当花瓣的 2D 屏幕投影落在人物轮廓表面时，
 * 通知粒子系统让花瓣"停留"在身体/手上。
 * 
 * 原理：
 *   1. 将分割蒙版缩小到低分辨率（如 60×80）
 *   2. 按列扫描找到每列最顶部的人物像素 → 形成"上边缘轮廓线"
 *   3. 花瓣投影到屏幕后，如果其 y 坐标接近该列的上边缘，判定为碰撞
 *   4. 同时检测花瓣是否在人物区域内部（手掌上方落入手掌区域）
 */
class BodyCollisionDetector {
  constructor() {
    // 低分辨率采样的宽高
    this.sampleW = 60;
    this.sampleH = 80;
    
    // 离屏 canvas 用于采样蒙版
    this._sampleCanvas = document.createElement('canvas');
    this._sampleCanvas.width = this.sampleW;
    this._sampleCanvas.height = this.sampleH;
    this._sampleCtx = this._sampleCanvas.getContext('2d', { willReadFrequently: true });
    
    // 碰撞数据：每列的顶部边缘 y 值（归一化 0~1），-1 表示该列无人物
    this.topEdge = new Float32Array(this.sampleW).fill(-1);
    
    // 人物蒙版的二值数组（用于判断花瓣是否在人物区域内）
    this.maskData = null;
    
    // 碰撞参数
    this.edgeThreshold = 0.06;    // 判定为"边缘碰撞"的 y 距离阈值（归一化）— 只让刚好触碰到人物边缘的花瓣停留
    this.insideEnabled = true;     // 是否也检测人物内部碰撞（花瓣从侧面飘入）
    this.headExcludeRatio = 0.55;  // 排除头部+脖子+上肩区域：人物区域顶部 55% 范围内不触发碰撞
    
    // 状态
    this.hasValidData = false;
    this.lastUpdateTime = 0;
    
    // === 人物距离感知 ===
    this.bodyAreaRatio = 0;           // 人物蒙版面积占比 (0~1)
    this._smoothedAreaRatio = 0;      // 平滑后的面积占比（IIR 低通）
    this.estimatedDistance = 1.0;     // 估算距离因子 (0=很近, 1=很远)
    
    // === 运动检测（用于涡流触发） ===
    this.prevMaskArea = 0;           // 上一帧蒙版面积（像素数）
    this.prevCenterX = 0.5;          // 上一帧蒙版重心 X（归一化）
    this.prevCenterY = 0.5;          // 上一帧蒙版重心 Y
    this.motionIntensity = 0;        // 运动强度 (0~1)，指数衰减
    this.motionDirection = 0;        // 运动方向（弧度）
    this.bigMotionEvent = null;      // 大动作事件 { cx, cy, intensity, direction }
    this._motionSmoothed = 0;        // 平滑后的运动量
    this._motionThreshold = 0.025;   // 触发大动作的阈值
    this._motionDecay = 0.92;        // 运动强度衰减系数
    this._warmupFrames = 0;          // 预热帧计数器
    this._warmupThreshold = 15;      // 前 N 帧不做运动检测（等分割稳定）
    
    // 屏幕尺寸
    this.screenW = window.innerWidth;
    this.screenH = window.innerHeight;
    
    // object-fit: cover 映射参数
    // 蒙版是视频原始比例，屏幕是窗口比例，CSS cover 会裁剪
    // 需要把屏幕坐标转换成蒙版坐标
    this._coverOffsetX = 0; // 裁剪偏移（归一化）
    this._coverOffsetY = 0;
    this._coverScaleX = 1;  // 映射缩放
    this._coverScaleY = 1;
    
    window.addEventListener('resize', () => {
      this.screenW = window.innerWidth;
      this.screenH = window.innerHeight;
      this._updateCoverMapping();
    });
  }
  
  /**
   * 计算 object-fit: cover 的坐标映射
   * 蒙版内部分辨率 = 视频原始分辨率 (vw × vh)
   * 屏幕显示区域 = screenW × screenH
   * CSS cover 会将蒙版裁剪后填满屏幕
   */
  _updateCoverMapping() {
    if (!this._videoW || !this._videoH) return;
    
    const vw = this._videoW;
    const vh = this._videoH;
    const sw = this.screenW;
    const sh = this.screenH;
    
    const videoRatio = vw / vh;
    const screenRatio = sw / sh;
    
    if (videoRatio > screenRatio) {
      // 视频更宽 → CSS cover 会裁剪左右
      // 垂直方向：100% 对齐
      // 水平方向：视频中间一段映射到屏幕全宽
      this._coverScaleY = 1;
      this._coverOffsetY = 0;
      
      // 屏幕全高对应蒙版全高
      // 屏幕全宽对应蒙版中间 (screenRatio/videoRatio) 部分
      const visibleFractionX = screenRatio / videoRatio;
      this._coverScaleX = visibleFractionX;
      this._coverOffsetX = (1 - visibleFractionX) / 2;
    } else {
      // 视频更高 → CSS cover 会裁剪上下
      this._coverScaleX = 1;
      this._coverOffsetX = 0;
      
      const visibleFractionY = videoRatio / screenRatio;
      this._coverScaleY = visibleFractionY;
      this._coverOffsetY = (1 - visibleFractionY) / 2;
    }
  }
  
  /**
   * 将屏幕坐标转换为蒙版空间的归一化坐标
   */
  _screenToMask(screenX, screenY) {
    const nx = screenX / this.screenW;  // 屏幕归一化 0~1
    const ny = screenY / this.screenH;
    
    // 转换到蒙版空间
    const mx = this._coverOffsetX + nx * this._coverScaleX;
    const my = this._coverOffsetY + ny * this._coverScaleY;
    
    return { mx, my };
  }
  
  /**
   * 用分割蒙版更新碰撞数据
   * @param {HTMLCanvasElement|ImageData|ImageBitmap} mask - 分割蒙版
   * @param {number} [videoW] - 视频原始宽度（用于 cover 映射）
   * @param {number} [videoH] - 视频原始高度
   */
  updateFromMask(mask, videoW, videoH) {
    if (!mask) {
      this.hasValidData = false;
      return;
    }
    
    // 记录视频尺寸并更新 cover 映射
    if (videoW && videoH && (this._videoW !== videoW || this._videoH !== videoH)) {
      this._videoW = videoW;
      this._videoH = videoH;
      this._updateCoverMapping();
    }
    
    const ctx = this._sampleCtx;
    const w = this.sampleW;
    const h = this.sampleH;
    
    // 将蒙版全拉伸到采样 canvas（不做 cover 裁剪）
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(mask, 0, 0, w, h);
    
    // 读取像素数据
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    
    // 创建二值蒙版 + 扫描上边缘（先写入临时数组）
    const tempMask = new Uint8Array(w * h);
    const tempEdge = new Float32Array(w).fill(-1);
    
    let bodyPixelCount = 0;
    
    for (let x = 0; x < w; x++) {
      let foundTop = false;
      for (let y = 0; y < h; y++) {
        const idx = (y * w + x) * 4;
        // MediaPipe 蒙版格式可能不同：
        //   方式1: RGB通道 — 人物=白色(RGB≈255), 背景=黑色(RGB≈0)
        //   方式2: Alpha通道 — 人物=alpha≈255, 背景=alpha≈0, RGB全白
        // 兼容两种方式：取 RGB 亮度和 alpha 中较大的来判断
        const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        const alpha = data[idx + 3];
        const isBody = brightness > 128 || (alpha > 128 && brightness > 50);
        tempMask[y * w + x] = isBody ? 1 : 0;
        
        if (isBody) bodyPixelCount++;
        
        if (isBody && !foundTop) {
          tempEdge[x] = y / h; // 归一化
          foundTop = true;
        }
      }
    }
    
    // 如果人物像素太少（< 0.5%），跳过此帧，保留上一帧的有效数据
    const total = w * h;
    const bodyRatio = bodyPixelCount / total;
    if (bodyRatio < 0.005 && this.hasValidData) {
      this.lastUpdateTime = performance.now();
      return;
    }
    
    // === 运动检测 ===
    // 计算蒙版重心
    let sumX = 0, sumY = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (tempMask[y * w + x] === 1) {
          sumX += x;
          sumY += y;
        }
      }
    }
    const curCenterX = bodyPixelCount > 0 ? (sumX / bodyPixelCount) / w : 0.5;
    const curCenterY = bodyPixelCount > 0 ? (sumY / bodyPixelCount) / h : 0.5;
    
    // 预热期：前 N 帧分割结果不稳定，跳过运动检测避免误触发涡流
    this._warmupFrames++;
    
    if (this._warmupFrames > this._warmupThreshold && this.prevMaskArea > 0 && bodyPixelCount > 0) {
      // 面积变化率（归一化到总像素）
      const areaDelta = Math.abs(bodyPixelCount - this.prevMaskArea) / total;
      // 重心偏移（归一化距离）
      const dCX = curCenterX - this.prevCenterX;
      const dCY = curCenterY - this.prevCenterY;
      const centerDist = Math.sqrt(dCX * dCX + dCY * dCY);
      
      // 综合运动量 = 面积变化 + 重心偏移（加权）
      const rawMotion = areaDelta * 2.0 + centerDist * 3.0;
      
      // 平滑：IIR 低通滤波
      this._motionSmoothed = this._motionSmoothed * 0.6 + rawMotion * 0.4;
      
      // 衰减
      this.motionIntensity *= this._motionDecay;
      
      // 检测大动作
      if (this._motionSmoothed > this._motionThreshold) {
        const intensity = Math.min(1.0, this._motionSmoothed / 0.12);
        this.motionIntensity = Math.max(this.motionIntensity, intensity);
        this.motionDirection = Math.atan2(dCY, dCX);
        
        // 触发大动作事件（外部可以读取并消费）
        // cx, cy 是人物屏幕中心的归一化坐标（考虑 cover 映射的逆变换）
        const screenCX = (curCenterX - this._coverOffsetX) / this._coverScaleX;
        const screenCY = (curCenterY - this._coverOffsetY) / this._coverScaleY;
        this.bigMotionEvent = {
          cx: screenCX,
          cy: screenCY,
          intensity: intensity,
          direction: this.motionDirection,
          // 旋转方向：重心向右移动 → 逆时针(-1)，向左 → 顺时针(1)
          rotSign: dCX > 0 ? -1 : 1
        };
      }
    }
    
    this.prevMaskArea = bodyPixelCount;
    this.prevCenterX = curCenterX;
    this.prevCenterY = curCenterY;
    
    // === 更新人物距离感知 ===
    this.bodyAreaRatio = bodyRatio;
    // IIR 低通滤波平滑，避免面积抖动导致花瓣大小突变
    this._smoothedAreaRatio = this._smoothedAreaRatio * 0.85 + bodyRatio * 0.15;
    // 将面积比映射到"距离因子"：面积越大 → 人越近 → 值越小
    // 典型范围：bodyRatio 0.05(远) ~ 0.5+(很近)
    this.estimatedDistance = Math.max(0, Math.min(1, 1 - this._smoothedAreaRatio / 0.45));
    
    // 有效帧，更新碰撞数据
    this.maskData = tempMask;
    this.topEdge.set(tempEdge);
    
    // 平滑上边缘（3 像素窗口中值滤波，减少噪声跳变）
    const smoothed = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const left = x > 0 ? this.topEdge[x - 1] : this.topEdge[x];
      const center = this.topEdge[x];
      const right = x < w - 1 ? this.topEdge[x + 1] : this.topEdge[x];
      
      // 如果当前列无人物但相邻有，跳过
      if (center < 0) {
        smoothed[x] = -1;
        continue;
      }
      
      const vals = [left, center, right].filter(v => v >= 0);
      vals.sort((a, b) => a - b);
      smoothed[x] = vals[Math.floor(vals.length / 2)];
    }
    this.topEdge.set(smoothed);
    
    this.hasValidData = true;
    this.lastUpdateTime = performance.now();
  }
  
  /**
   * 检测一个屏幕坐标点是否与人体碰撞
   * @param {number} screenX - 屏幕 x 坐标（像素）
   * @param {number} screenY - 屏幕 y 坐标（像素）
   * @returns {{ hit: boolean, type: string, surfaceY: number }}
   *   hit: 是否碰撞
   *   type: 'edge'（边缘碰撞）或 'inside'（内部碰撞）
   *   surfaceY: 碰撞表面的归一化 y 坐标
   */
  testPoint(screenX, screenY) {
    if (!this.hasValidData) return { hit: false, type: 'none', surfaceY: 0 };
    
    // 屏幕坐标 → 蒙版空间归一化坐标（考虑 object-fit: cover 裁剪）
    const { mx, my } = this._screenToMask(screenX, screenY);
    
    // 映射到采样网格
    const col = Math.floor(mx * this.sampleW);
    if (col < 0 || col >= this.sampleW) return { hit: false, type: 'none', surfaceY: 0 };
    
    const edgeY = this.topEdge[col];
    if (edgeY < 0) return { hit: false, type: 'none', surfaceY: 0 };
    
    // 找到这一列的底部边缘（用于计算人物高度）
    let bottomY = edgeY;
    if (this.maskData) {
      for (let y = this.sampleH - 1; y >= 0; y--) {
        if (this.maskData[y * this.sampleW + col] === 1) {
          bottomY = y / this.sampleH;
          break;
        }
      }
    }
    
    // 排除头部区域：人物上部 headExcludeRatio 范围不触发碰撞
    const bodyHeight = bottomY - edgeY;
    const headCutoff = edgeY + bodyHeight * this.headExcludeRatio;
    if (my < headCutoff) return { hit: false, type: 'none', surfaceY: 0 };
    
    // 边缘碰撞：花瓣 y 接近上边缘（从上方落入），但排除头部后从 headCutoff 开始
    const dy = my - headCutoff;
    if (dy >= -this.edgeThreshold && dy <= this.edgeThreshold * 2) {
      return { hit: true, type: 'edge', surfaceY: headCutoff };
    }
    
    // 内部碰撞：花瓣已经在人物区域内
    if (this.insideEnabled && dy > 0) {
      const row = Math.floor(my * this.sampleH);
      if (row >= 0 && row < this.sampleH) {
        const isInside = this.maskData[row * this.sampleW + col] === 1;
        if (isInside) {
          return { hit: true, type: 'inside', surfaceY: headCutoff };
        }
      }
    }
    
    return { hit: false, type: 'none', surfaceY: 0 };
  }
  
  /**
   * 检查某个屏幕坐标是否在人物区域内
   */
  isInsideBody(screenX, screenY) {
    if (!this.hasValidData || !this.maskData) return false;
    
    const { mx, my } = this._screenToMask(screenX, screenY);
    
    const col = Math.floor(mx * this.sampleW);
    const row = Math.floor(my * this.sampleH);
    
    if (col < 0 || col >= this.sampleW || row < 0 || row >= this.sampleH) return false;
    
    return this.maskData[row * this.sampleW + col] === 1;
  }
  
  /**
   * 数据是否有效（人体分割是否在运行）
   */
  get isActive() {
    // 如果超过 2 秒没更新，认为无效
    return this.hasValidData && (performance.now() - this.lastUpdateTime < 2000);
  }
}
