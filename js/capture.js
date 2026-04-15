/**
 * 拍照 & 录像模块
 * 将摄像头画面 + 花瓣各层合成到离屏 canvas，支持截图保存和视频录制
 */
class CaptureManager {
  constructor() {
    this.compositeCanvas = document.createElement('canvas');
    this.compositeCtx = this.compositeCanvas.getContext('2d');

    // 录像相关
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;
    this.recordingTimer = null;
    this.recordingStartTime = 0;

    // UI 元素（外部注入）
    this.$btnPhoto = null;
    this.$btnRecord = null;
    this.$recordTime = null;
    this.$flash = null;
    this.$toast = null;

    // 源元素
    this.video = document.getElementById('camera-video');
    this.fallbackBg = document.getElementById('fallback-bg');
    this.canvasFar = document.getElementById('canvas-far');
    this.canvasMid = document.getElementById('canvas-mid');
    this.canvasNear = document.getElementById('canvas-near');
    this.canvasPerson = document.getElementById('canvas-person');
    // 录像用：mid+near 合并层（由 particleSystem 动态创建，init 时注入）
    this.canvasMidNear = null;

    // 外部注入 CameraManager 引用（用于判断前置/后置）
    this.cameraManager = null;

    // 外部注入 PetalParticleSystem 引用（拍照时临时提升 DPR）
    this.particleSystem = null;

    // === 设备性能分级（外部注入） ===
    this.deviceTier = null; // 'low' | 'medium' | 'high'

    // === 运动模糊（多帧累积） ===
    // 保存最近 N 帧的花瓣层快照，合成时叠加产生拖影
    this._motionBlurFrames = 3;         // 保留历史帧数
    this._petalHistoryBuffers = [];     // ring buffer: 离屏 canvas 数组
    this._historyWriteIndex = 0;        // 当前写入位置
    this._historyFilled = 0;            // 已填充的帧数
    this._motionBlurInited = false;

    // === 录像合成帧率节流 ===
    // 优化后每帧合成负担大幅减轻（1-pass + 0.75x 分辨率），可以每帧都合成
    // 确保 captureStream 每次取到新画面，消除"翻图片"感
    this._compositeInterval = 1;        // 每帧都合成（≈60fps → captureStream 24fps 取帧）
    this._compositeCounter = 0;         // 帧计数器

    // === 录像性能优化：录像前状态存储 ===
    this._preRecordPetalCount = null;   // 方案A: 录像前花瓣数量（结束后恢复）
    this._preRecordFrameSkip = null;    // 方案B: 录像前分割帧跳数（结束后恢复）
    // 外部注入 PersonSegmentation 引用（录像时降低分割频率）
    this.segmentation = null;
  }

  /** 重置运动模糊历史帧缓存（密度变化时调用，防止旧帧残留） */
  resetMotionBlurHistory() {
    this._historyFilled = 0;
    this._historyWriteIndex = 0;
    if (this._petalHistoryBuffers) {
      for (const buf of this._petalHistoryBuffers) {
        if (buf && buf.ctx) {
          buf.ctx.clearRect(0, 0, buf.canvas.width, buf.canvas.height);
        }
      }
    }
  }

  init() {
    this.$btnPhoto = document.getElementById('btn-photo');
    this.$btnRecord = document.getElementById('btn-record');
    this.$recordTime = document.getElementById('record-time');
    this.$flash = document.getElementById('capture-flash');
    this.$toast = document.getElementById('capture-toast');

    // === 安卓端隐藏录像按钮 ===
    // 安卓微信/浏览器中录像保存极不稳定（webm 格式兼容差、MP4 编码支持参差不齐、
    // 微信内 <a download> / navigator.share 对视频均不可靠），体验远差于拍照，故直接隐藏
    const isAndroidLike = /Android|OpenHarmony|HarmonyOS/i.test(navigator.userAgent);
    if (isAndroidLike && this.$btnRecord) {
      this.$btnRecord.parentElement.style.display = 'none';
      console.log('[Capture] 安卓端：录像按钮已隐藏');
    }

    // 同时绑定 click 和 touchend（iOS Safari 兼容），用防重避免双触发
    let lastPhotoTime = 0;
    const photoHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastPhotoTime < 500) return; // 500ms 防重
      lastPhotoTime = now;
      this.takePhoto();
    };
    this.$btnPhoto.addEventListener('click', photoHandler);
    this.$btnPhoto.addEventListener('touchend', photoHandler);

    // 安卓端不绑定录像事件
    if (isAndroidLike) {
      // 跳过录像按钮事件绑定
    } else {
    let lastRecordTime = 0;
    const recordHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastRecordTime < 500) return;
      lastRecordTime = now;
      this.toggleRecording();
    };
    this.$btnRecord.addEventListener('click', recordHandler);
    this.$btnRecord.addEventListener('touchend', recordHandler);
    }

    // 从粒子系统获取 mid+near 合并层离屏 canvas
    if (this.particleSystem && this.particleSystem.displayLayers.midNear) {
      this.canvasMidNear = this.particleSystem.displayLayers.midNear.canvas;
    }

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    // 拍照时用高清分辨率，录像时重新设置为 1x
    this._updateCanvasSize();
  }

  _updateCanvasSize() {
    const tier = this.deviceTier || 'high';
    let dpr, scale;
    if (this.isRecording) {
      dpr = 1;
      // 低端机录像进一步缩小到 0.5x（像素量再减56%）
      scale = tier === 'low' ? 0.5 : 0.75;
    } else {
      // 拍照时：低端机 DPR=1（像素量减75%），中端机限 2，高端机最高 3
      const maxDpr = tier === 'low' ? 1 : (tier === 'medium' ? 2 : 3);
      dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      scale = 1;
    }
    this.compositeCanvas.width = Math.round(window.innerWidth * dpr * scale);
    this.compositeCanvas.height = Math.round(window.innerHeight * dpr * scale);
  }

  /**
   * 初始化运动模糊的离屏 buffer（延迟初始化，尺寸匹配合成 canvas）
   */
  _initMotionBlurBuffers(w, h) {
    this._petalHistoryBuffers = [];
    for (let i = 0; i < this._motionBlurFrames; i++) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      this._petalHistoryBuffers.push({
        canvas: c,
        ctx: c.getContext('2d'),
      });
    }
    this._historyWriteIndex = 0;
    this._historyFilled = 0;
    this._motionBlurInited = true;
    this._motionBlurW = w;
    this._motionBlurH = h;

    // 当前帧花瓣临时合成 canvas
    if (!this._petalTempCanvas) {
      this._petalTempCanvas = document.createElement('canvas');
      this._petalTempCtx = this._petalTempCanvas.getContext('2d');
    }
    this._petalTempCanvas.width = w;
    this._petalTempCanvas.height = h;
  }

  /**
   * 将人物遮罩层绘制到合成 canvas（远景花瓣之后、中景花瓣之前调用）
   * 
   * canvasPerson 由 segmentation.js 生成：
   *   - 人物区域 = 视频帧 RGB + alpha=255
   *   - 非人物区域 = alpha=0（完全透明）
   * 
   * 用默认 source-over 直接绘制即可：
   *   - 人物不透明像素自然覆盖下层远景花瓣
   *   - 透明区域不影响已有花瓣
   * 
   * 不使用任何 globalCompositeOperation 切换，避免污染后续绘制。
   * 
   * @param {CanvasRenderingContext2D} ctx - 目标 canvas 上下文
   * @param {number} w - 目标宽度
   * @param {number} h - 目标高度
   */
  _drawPersonMask(ctx, w, h) {
    if (!this.canvasPerson || this.canvasPerson.width === 0 || this.canvasPerson.height === 0) return;

    // canvasPerson 尺寸 = 视频原始分辨率，需要做 object-fit: cover 映射
    // 映射参数与视频绘制（第 294-310 行）完全一致
    const vw = this.canvasPerson.width;
    const vh = this.canvasPerson.height;
    const scale = Math.max(w / vw, h / vh);
    const sw = vw * scale;
    const sh = vh * scale;
    const sx = (w - sw) / 2;
    const sy = (h - sh) / 2;

    // 前置摄像头需要水平镜像翻转（与视频绘制保持一致）
    const isFront = this.cameraManager && this.cameraManager.facingMode === 'user';
    if (isFront) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.canvasPerson, 0, 0, vw, vh, sx, sy, sw, sh);
      ctx.restore();
    } else {
      ctx.drawImage(this.canvasPerson, 0, 0, vw, vh, sx, sy, sw, sh);
    }
  }

  /**
   * 将所有可见层合成到离屏 canvas（含运动模糊）
   */
  _composite() {
    const ctx = this.compositeCtx;
    const w = this.compositeCanvas.width;
    const h = this.compositeCanvas.height;

    ctx.clearRect(0, 0, w, h);

    // 1. 摄像头视频 / 降级背景
    const videoUsable = this.video && !this.video.classList.contains('hidden') &&
      this.video.readyState >= 2 && this.video.videoWidth > 0;
    if (videoUsable) {
      // 保持 object-fit: cover 的效果
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      const scale = Math.max(w / vw, h / vh);
      const sw = vw * scale;
      const sh = vh * scale;
      const sx = (w - sw) / 2;
      const sy = (h - sh) / 2;

      // 前置摄像头需要水平镜像翻转
      const isFront = this.cameraManager && this.cameraManager.facingMode === 'user';
      if (isFront) {
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(this.video, sx, sy, sw, sh);
        ctx.restore();
      } else {
        ctx.drawImage(this.video, sx, sy, sw, sh);
      }
    } else {
      // 绘制降级背景渐变
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#1a0a2e');
      grad.addColorStop(0.25, '#2d1b4e');
      grad.addColorStop(0.5, '#4a2068');
      grad.addColorStop(0.75, '#2d1b4e');
      grad.addColorStop(1, '#1a0a2e');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    // DPR 补偿：合成 canvas 分辨率是屏幕的 N 倍，模糊半径需等比放大
    const compositeDPR = w / window.innerWidth;

    // === 录像时：跳过所有模糊，直接绘制花瓣层（最大性能） ===
    if (this.isRecording) {
      this._compositeRecordNoBlur(ctx, w, h);
      return;
    }

    // === 非录像（拍照）时 ===
    const tier = this.deviceTier || 'high';

    // 低端/中端机：跳过运动模糊 + 跳过模糊绘制，直接合成当前帧（大幅加速）
    if (tier === 'low' || tier === 'medium') {
      // 远景花瓣层（低端机不做模糊，直接绘制）
      if (this.canvasFar.width > 0) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        if (tier === 'low') {
          // low 档：直接 drawImage，完全跳过模糊
          ctx.drawImage(this.canvasFar, 0, 0, w, h);
        } else {
          // medium 档：保留模糊，但不做运动模糊叠加
          this._drawBlurred(ctx, this.canvasFar, w, h, 2.5 * compositeDPR);
        }
        ctx.restore();
      }
      // 人物遮罩层
      this._drawPersonMask(ctx, w, h);
      // 中景花瓣层
      if (this.canvasMid.width > 0) {
        ctx.drawImage(this.canvasMid, 0, 0, w, h);
      }
      // 近景花瓣层
      if (this.canvasNear.width > 0) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        if (tier === 'low') {
          ctx.drawImage(this.canvasNear, 0, 0, w, h);
        } else {
          this._drawBlurred(ctx, this.canvasNear, w, h, 4 * compositeDPR);
        }
        ctx.restore();
      }
      return;
    }

    // === 高端机：完整运动模糊流程 ===

    // 懒初始化 / 尺寸变化时重建 buffer
    if (!this._motionBlurInited || this._motionBlurW !== w || this._motionBlurH !== h) {
      this._initMotionBlurBuffers(w, h);
    }

    const tmpCtx = this._petalTempCtx;
    tmpCtx.clearRect(0, 0, w, h);

    // 2. 远景花瓣层（CSS blur(2.5px) 对应 + 轻微降透）
    if (this.canvasFar.width > 0) {
      tmpCtx.save();
      tmpCtx.globalAlpha = 0.9;
      this._drawBlurred(tmpCtx, this.canvasFar, w, h, 2.5 * compositeDPR);
      tmpCtx.restore();
    }

    // 3. 人物遮罩层 — 遮挡远景花瓣，保持人在远景前面
    this._drawPersonMask(tmpCtx, w, h);

    // 4. 中景花瓣层（清晰，素材已预处理去边）
    if (this.canvasMid.width > 0) {
      tmpCtx.drawImage(this.canvasMid, 0, 0, w, h);
    }

    // 5. 近景花瓣层（CSS blur(4px) 对应 + 降低透明度）
    if (this.canvasNear.width > 0) {
      tmpCtx.save();
      tmpCtx.globalAlpha = 0.55;
      this._drawBlurred(tmpCtx, this.canvasNear, w, h, 4 * compositeDPR);
      tmpCtx.restore();
    }

    // --- 运动模糊叠加 ---
    const alphaLevels = [0.12, 0.20, 0.30];
    const totalHistory = Math.min(this._historyFilled, this._motionBlurFrames);
    for (let age = totalHistory; age >= 1; age--) {
      const bufIdx = (this._historyWriteIndex - age + this._motionBlurFrames) % this._motionBlurFrames;
      const alphaIdx = this._motionBlurFrames - age;
      const alpha = alphaLevels[alphaIdx] || 0.10;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(this._petalHistoryBuffers[bufIdx].canvas, 0, 0, w, h);
      ctx.restore();
    }

    // 当前帧花瓣全透明度叠加
    ctx.drawImage(this._petalTempCanvas, 0, 0, w, h);

    // 将当前帧花瓣层存入 ring buffer 供下一帧使用
    const writeBuf = this._petalHistoryBuffers[this._historyWriteIndex];
    writeBuf.ctx.clearRect(0, 0, w, h);
    writeBuf.ctx.drawImage(this._petalTempCanvas, 0, 0, w, h);
    this._historyWriteIndex = (this._historyWriteIndex + 1) % this._motionBlurFrames;
    if (this._historyFilled < this._motionBlurFrames) this._historyFilled++;
  }

  /**
   * 拍照前预缓存花瓣层历史帧
   * 在不影响合成 canvas 的情况下，快速将当前花瓣层快照存入 ring buffer
   */
  _preloadMotionBlurHistory() {
    const w = this.compositeCanvas.width;
    const h = this.compositeCanvas.height;

    if (!this._motionBlurInited || this._motionBlurW !== w || this._motionBlurH !== h) {
      this._initMotionBlurBuffers(w, h);
    }
    if (!this._petalTempCanvas) return;

    const tmpCtx = this._petalTempCtx;

    // 快速连续存入 N 帧——实际花瓣已经在每帧动画中移动了位置，
    // 所以这里每次读到的 canvasFar/canvasMid/canvasNear 都是最新一帧的位置。
    // 我们只需把当前帧花瓣快照存入 buffer 即可
    // （真正的时间差异来自动画循环中花瓣的位移，预缓存确保 buffer 非空）
    // DPR 补偿：与 _composite() 保持一致
    const compositeDPR = w / window.innerWidth;

    for (let f = 0; f < this._motionBlurFrames; f++) {
      tmpCtx.clearRect(0, 0, w, h);

      if (this.canvasFar.width > 0) {
        tmpCtx.save();
        tmpCtx.globalAlpha = 0.9;
        this._drawBlurred(tmpCtx, this.canvasFar, w, h, 2.5 * compositeDPR);
        tmpCtx.restore();
      }
      // 人物遮罩层 — 遮挡远景花瓣（与 _composite 保持一致）
      this._drawPersonMask(tmpCtx, w, h);
      if (this.canvasMid.width > 0) {
        tmpCtx.drawImage(this.canvasMid, 0, 0, w, h);
      }
      if (this.canvasNear.width > 0) {
        tmpCtx.save();
        tmpCtx.globalAlpha = 0.55;
        this._drawBlurred(tmpCtx, this.canvasNear, w, h, 5 * compositeDPR);
        tmpCtx.restore();
      }
      const writeBuf = this._petalHistoryBuffers[this._historyWriteIndex];
      writeBuf.ctx.clearRect(0, 0, w, h);
      writeBuf.ctx.drawImage(this._petalTempCanvas, 0, 0, w, h);
      this._historyWriteIndex = (this._historyWriteIndex + 1) % this._motionBlurFrames;
      if (this._historyFilled < this._motionBlurFrames) this._historyFilled++;
    }
  }

  /**
   * 高质量模糊绘制（多级方案）
   * 1. 优先使用 WebGL GPU 高斯模糊（效果等同 CSS blur）
   * 2. 次选 Canvas 2D ctx.filter（Chrome/Firefox 支持）
   * 3. 降级：多轮缩放模糊
   */
  _drawBlurred(ctx, sourceCanvas, w, h, blurRadius) {
    // 确保所有绘制都启用高质量平滑
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 方案 1：WebGL GPU 高斯模糊（iOS Safari 最佳方案）
    if (!this._webglBlur) {
      this._webglBlur = new WebGLBlurRenderer();
    }
    if (this._webglBlur.isReady) {
      const ok = this._webglBlur.blur(ctx, sourceCanvas, w, h, blurRadius);
      if (ok) return;
    }

    // 方案 2：Canvas 2D filter（Chrome/Firefox 支持，iOS Safari 不支持）
    if (this._filterSupported === undefined) {
      this._filterSupported = this._testFilterSupport();
    }
    if (this._filterSupported) {
      ctx.filter = `blur(${blurRadius}px)`;
      ctx.drawImage(sourceCanvas, 0, 0, w, h);
      ctx.filter = 'none';
      return;
    }

    // 方案 3：降级 — 多轮缩放模糊
    if (!this._blurCanvas) {
      this._blurCanvas = document.createElement('canvas');
      this._blurCtx = this._blurCanvas.getContext('2d');
    }
    if (!this._blurCanvas2) {
      this._blurCanvas2 = document.createElement('canvas');
      this._blurCtx2 = this._blurCanvas2.getContext('2d');
    }

    const s1 = Math.max(0.05, 1 / (1 + blurRadius * 2.0));
    const bw1 = Math.max(2, Math.floor(w * s1));
    const bh1 = Math.max(2, Math.floor(h * s1));
    this._blurCanvas.width = bw1;
    this._blurCanvas.height = bh1;
    this._blurCtx.imageSmoothingEnabled = true;
    this._blurCtx.imageSmoothingQuality = 'high';
    this._blurCtx.drawImage(sourceCanvas, 0, 0, bw1, bh1);

    const midScale = Math.min(0.5, 0.25 + blurRadius * 0.02);
    const midW = Math.max(4, Math.floor(w * midScale));
    const midH = Math.max(4, Math.floor(h * midScale));
    this._blurCanvas2.width = midW;
    this._blurCanvas2.height = midH;
    this._blurCtx2.imageSmoothingEnabled = true;
    this._blurCtx2.imageSmoothingQuality = 'high';
    this._blurCtx2.drawImage(this._blurCanvas, 0, 0, bw1, bh1, 0, 0, midW, midH);

    if (blurRadius > 2) {
      this._blurCanvas.width = midW;
      this._blurCanvas.height = midH;
      this._blurCtx.drawImage(this._blurCanvas2, 0, 0);
      const midW2 = Math.max(4, Math.floor(w * 0.35));
      const midH2 = Math.max(4, Math.floor(h * 0.35));
      this._blurCanvas2.width = midW2;
      this._blurCanvas2.height = midH2;
      this._blurCtx2.drawImage(this._blurCanvas, 0, 0, midW, midH, 0, 0, midW2, midH2);
    }

    ctx.drawImage(this._blurCanvas2, 0, 0, this._blurCanvas2.width, this._blurCanvas2.height, 0, 0, w, h);
  }



  /**
   * 录像专用：2-pass 无模糊合成
   * far 单独 → 人物遮罩 → mid+near 合并层
   * 比 3-pass 少一次 WebGL 渲染 + readback，保留人物遮罩穿插效果
   */
  _compositeRecordNoBlur(ctx, w, h) {
    // 远景花瓣层（直接绘制，不模糊）
    if (this.canvasFar.width > 0) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.canvasFar, 0, 0, w, h);
      ctx.restore();
    }

    // 人物遮罩层（遮挡远景花瓣，在中近景之前）
    this._drawPersonMask(ctx, w, h);

    // 中景+近景合并层（2-pass 优化：一次 WebGL 渲染 mid+near）
    if (this.canvasMidNear && this.canvasMidNear.width > 0) {
      ctx.drawImage(this.canvasMidNear, 0, 0, w, h);
    } else {
      // 降级：未拿到合并层时，仍读取分离的 mid/near
      if (this.canvasMid.width > 0) {
        ctx.drawImage(this.canvasMid, 0, 0, w, h);
      }
      if (this.canvasNear.width > 0) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.drawImage(this.canvasNear, 0, 0, w, h);
        ctx.restore();
      }
    }
  }

  /**
   * 检测 Canvas 2D filter 是否真正有效
   * 原理：画一个红色方块，加 blur(10px) 后检查角落是否有颜色扩散
   */
  _testFilterSupport() {
    try {
      const testCanvas = document.createElement('canvas');
      testCanvas.width = 40;
      testCanvas.height = 40;
      const testCtx = testCanvas.getContext('2d');
      if (!testCtx || typeof testCtx.filter === 'undefined') return false;

      // 在中心画一个小红块
      testCtx.fillStyle = '#ff0000';
      testCtx.fillRect(15, 15, 10, 10);

      // 用 blur 重新画到另一个 canvas
      const testCanvas2 = document.createElement('canvas');
      testCanvas2.width = 40;
      testCanvas2.height = 40;
      const testCtx2 = testCanvas2.getContext('2d');
      testCtx2.filter = 'blur(10px)';
      testCtx2.drawImage(testCanvas, 0, 0);
      testCtx2.filter = 'none';

      // 检查角落（0,0）是否有颜色——如果 blur 生效了，红色会扩散到角落
      const pixel = testCtx2.getImageData(0, 0, 1, 1).data;
      // 如果 blur 不生效，角落像素是透明的 (0,0,0,0)
      // 如果 blur 生效了，角落会有一些红色分量
      const hasBlur = pixel[0] > 0 || pixel[3] > 0;
      console.log('Canvas filter blur 检测:', hasBlur ? '支持' : '不支持', pixel);
      return hasBlur;
    } catch (e) {
      console.warn('Canvas filter 检测异常:', e);
      return false;
    }
  }

  // ============================================
  // 拍照
  // ============================================
  takePhoto() {
    // 拍照用高清分辨率
    if (this.isRecording) {
      // 录像中不改尺寸，直接截帧
    } else {
      this._updateCanvasSize();
    }

    // === 拍照前临时提升 WebGL DPR（仅 PC 端）===
    // 移动端保持 2x DPR，不做提升（3x 导致合成慢 + 图片大 + 保存卡）
    let dprRestored = false;
    const ps = this.particleSystem;
    const isMobileShot = /Mobi|Android|iPhone|iPad|OpenHarmony|HarmonyOS/i.test(navigator.userAgent);
    if (ps && ps.renderer && !this.isRecording && !isMobileShot) {
      const nativeDPR = Math.min(window.devicePixelRatio || 1, 3);
      const currentDPR = ps.renderer.getPixelRatio();
      if (nativeDPR > currentDPR) {
        console.log(`[拍照] 临时提升 WebGL DPR: ${currentDPR} → ${nativeDPR}`);
        ps.renderer.setPixelRatio(nativeDPR);
        ps.renderer.setSize(window.innerWidth, window.innerHeight);
        // 同步更新 2D 显示层分辨率
        const dpr2d = Math.min(window.devicePixelRatio || 1, 3);
        for (const layer of Object.values(ps.displayLayers)) {
          layer.canvas.width = window.innerWidth * dpr2d;
          layer.canvas.height = window.innerHeight * dpr2d;
        }
        // 强制渲染一帧高清花瓣（复用 update 中的 3-pass 渲染逻辑）
        ps.update(window._gyroscope ? window._gyroscope.getCameraData() : null);
        dprRestored = true;
      }
    }

    const tier = this.deviceTier || 'high';

    try {
      // 预缓存花瓣层历史帧（仅 PC 端高端机，移动端/低端机跳过以加速）
      if (!this.isRecording && !isMobileShot && tier === 'high') {
        this._preloadMotionBlurHistory();
      }
      this._composite();
    } catch (err) {
      console.error('合成画面失败:', err);
      this._showToast('拍照失败: 合成出错');
      // 恢复 DPR
      if (dprRestored && ps && ps.renderer) {
        ps.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        ps.renderer.setSize(window.innerWidth, window.innerHeight);
        const dprRestore = Math.min(window.devicePixelRatio || 1, 2);
        for (const layer of Object.values(ps.displayLayers)) {
          layer.canvas.width = window.innerWidth * dprRestore;
          layer.canvas.height = window.innerHeight * dprRestore;
        }
      }
      return;
    }

    // === 恢复 WebGL DPR ===
    if (dprRestored && ps && ps.renderer) {
      ps.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      ps.renderer.setSize(window.innerWidth, window.innerHeight);
      const dprRestore = Math.min(window.devicePixelRatio || 1, 2);
      for (const layer of Object.values(ps.displayLayers)) {
        layer.canvas.width = window.innerWidth * dprRestore;
        layer.canvas.height = window.innerHeight * dprRestore;
      }
      console.log('[拍照] WebGL DPR 已恢复');
    }

    // 闪光效果
    if (this.$flash) {
      this.$flash.classList.add('active');
      setTimeout(() => this.$flash.classList.remove('active'), 300);
    }

    // 移动端用 JPEG（体积小、导出快），PC 端用 PNG（无损）
    const imgFormat = isMobileShot ? 'image/jpeg' : 'image/png';
    const imgExt = isMobileShot ? '.jpg' : '.png';
    const filename = 'petals_' + this._timestamp() + imgExt;

    // JPEG 质量：低端机 0.5（极致压缩），中端机 0.85，高端机 0.92
    const jpegQuality = tier === 'low' ? 0.50 : (tier === 'medium' ? 0.85 : 0.92);

    // 导出 blob → 弹出预览界面（带分级超时保护）
    try {
      let blobDone = false;

      // 软超时：提示正在处理（不放弃）
      const softTimeoutMs = tier === 'low' ? 8000 : (tier === 'medium' ? 6000 : 5000);
      // 硬超时：真正放弃
      const hardTimeoutMs = tier === 'low' ? 20000 : (tier === 'medium' ? 15000 : 10000);

      const softTimer = setTimeout(() => {
        if (!blobDone) {
          console.log('[拍照] toBlob 软超时，提示等待');
          this._showToast('正在合成图片，请稍候...');
        }
      }, softTimeoutMs);

      const hardTimer = setTimeout(() => {
        if (!blobDone) {
          blobDone = true;
          console.warn(`[拍照] toBlob 硬超时 (${hardTimeoutMs}ms)`);
          this._showToast('图片合成超时，请重试');
        }
      }, hardTimeoutMs);

      this.compositeCanvas.toBlob((blob) => {
        if (blobDone) return; // 已硬超时，忽略回调
        blobDone = true;
        clearTimeout(softTimer);
        clearTimeout(hardTimer);

        if (!blob) {
          this._showToast('拍照失败: 图片生成为空');
          return;
        }

        // blob 大小检查：超过 4MB 自动降质量重新导出
        if (blob.size > 4 * 1024 * 1024 && imgFormat === 'image/jpeg') {
          console.log(`[拍照] blob 过大(${(blob.size/1024/1024).toFixed(1)}MB)，降质量重导`);
          this.compositeCanvas.toBlob((smallBlob) => {
            this._showPhotoPreview(smallBlob || blob, filename);
          }, 'image/jpeg', 0.6);
          return;
        }

        // 拍照后先弹预览，用户再选择保存/分享/关闭
        this._showPhotoPreview(blob, filename);
      }, imgFormat, isMobileShot ? jpegQuality : undefined);
    } catch (err) {
      console.error('toBlob 调用失败:', err);
      this._showToast('拍照失败');
    }
  }

  /**
   * 拍照预览：快门闪光 → 带圆角边框的近全屏预览，底部保存/重拍按钮
   * 用户必须点击保存或重拍才会关闭预览
   */
  _showPhotoPreview(blob, filename) {
    const imgUrl = URL.createObjectURL(blob);

    // 检测是否为安卓微信个人版
    const env = this._detectEnv();
    const isAndroidWechat = env.isAndroidLike && env.isWxPersonal;

    // 清理之前的预览
    const oldOverlay = document.getElementById('photo-preview-overlay');
    if (oldOverlay) oldOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'photo-preview-overlay';
    overlay.className = 'photo-preview-overlay';

    // 安卓微信：「全屏查看」按钮 + 提示文案；其他环境：「保存」按钮
    const saveBtnHtml = isAndroidWechat
      ? `<button class="photo-preview-btn photo-preview-btn-primary" id="photo-preview-save">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
          <span>全屏查看</span>
        </button>`
      : `<button class="photo-preview-btn photo-preview-btn-primary" id="photo-preview-save">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>保存</span>
        </button>`;

    const hintHtml = isAndroidWechat
      ? `<p class="photo-preview-hint" style="color:rgba(255,255,255,0.5);font-size:11px;text-align:center;margin:8px 0 0;line-height:1.6;">受系统限制暂不支持直接保存，请截屏或从浏览器打开</p>`
      : '';

    overlay.innerHTML = `
      <div class="photo-preview-frame">
        <img class="photo-preview-img" />
      </div>
      <div class="photo-preview-actions">
        <button class="photo-preview-btn" id="photo-preview-retake">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          <span>重拍</span>
        </button>
        ${saveBtnHtml}
      </div>
      ${hintHtml}
    `;
    document.body.appendChild(overlay);

    const img = overlay.querySelector('.photo-preview-img');
    img.src = imgUrl;

    // 入场动效：先从略大缩放到正常大小（模拟快门捕获感）
    requestAnimationFrame(() => {
      overlay.classList.add('show');
    });

    // 关闭预览
    const cleanup = () => {
      overlay.classList.add('photo-preview-exit');
      setTimeout(() => {
        overlay.remove();
        URL.revokeObjectURL(imgUrl);
      }, 300);
    };

    // 重拍（click + touchend 双绑，iOS 兼容）
    let retakeDone = false;
    const retakeHandler = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (retakeDone) return; retakeDone = true;
      cleanup();
    };
    overlay.querySelector('#photo-preview-retake').addEventListener('click', retakeHandler);
    overlay.querySelector('#photo-preview-retake').addEventListener('touchend', retakeHandler);

    // 保存/全屏查看（click + touchend 双绑）
    let saveDone = false;
    const saveHandler = (e) => {
      e.stopPropagation();
      if (saveDone) return; saveDone = true;
      if (isAndroidWechat) {
        // 安卓微信：全屏查看图片（纯净模式，触摸关闭）
        this._showFullscreenImage(blob);
        cleanup();
      } else {
        this._savePhoto(blob, filename, cleanup);
      }
    };
    overlay.querySelector('#photo-preview-save').addEventListener('click', saveHandler);
    overlay.querySelector('#photo-preview-save').addEventListener('touchend', saveHandler);
  }

  /**
   * 纯净全屏查看图片（安卓微信专用）
   * 全屏黑底展示图片，无任何引导文字和按钮，触摸屏幕即关闭
   * @param {Blob} blob - 图片 Blob
   */
  _showFullscreenImage(blob) {
    const old = document.getElementById('fullscreen-image-overlay');
    if (old) old.remove();

    const imgSrc = URL.createObjectURL(blob);

    const overlay = document.createElement('div');
    overlay.id = 'fullscreen-image-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#000;display:flex;align-items:center;justify-content:center;cursor:pointer;';

    const img = document.createElement('img');
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;pointer-events:none;';
    img.src = imgSrc;
    overlay.appendChild(img);

    document.body.appendChild(overlay);

    // 触摸/点击屏幕即关闭
    const close = () => {
      overlay.remove();
      URL.revokeObjectURL(imgSrc);
    };
    overlay.addEventListener('click', close);
    overlay.addEventListener('touchend', (e) => {
      e.preventDefault();
      close();
    });
  }

  /**
   * 检测是否在微信浏览器中
   */
  _isWechat() {
    return /MicroMessenger/i.test(navigator.userAgent);
  }

  /**
   * 检测环境类型（缓存结果，避免重复判断）
   */
  _detectEnv() {
    if (this._envCache) return this._envCache;
    const ua = navigator.userAgent;
    const isAndroid = /Android/i.test(ua);
    const isHarmony = /OpenHarmony|HarmonyOS/i.test(ua);
    const isWx = /MicroMessenger/i.test(ua);
    const isWxWork = /wxwork/i.test(ua);
    this._envCache = {
      isAndroid,
      isHarmony,
      // 鸿蒙系统按 Android 类似路径处理（鸿蒙 NEXT UA 不含 Android 字段）
      isAndroidLike: isAndroid || isHarmony,
      isWxPersonal: isWx && !isWxWork,
      isWxWork: isWx && isWxWork,
      isQQNews: /qqnews/i.test(ua),
      isQQ: /\bQQ\//i.test(ua) || /MQQBrowser/i.test(ua),
      isQQBrowser: /QQBrowser/i.test(ua),
      isTBS: /TBS\//i.test(ua) || /Xweb\//i.test(ua),
      isWindows: /Windows/i.test(ua),
      isMobile: /Mobi|Android|iPhone|iPad|iPod|OpenHarmony|HarmonyOS/i.test(ua),
    };
    return this._envCache;
  }

  /**
   * 保存照片/视频 — 统一优先级链（分环境精细化处理）
   * 
   * 优先级：
   *   1. navigator.share (files) → 保存到相册（最优，非Windows/非微信/非安卓WebView）
   *   2. 平台专用 JSBridge（微信 imagePreview、QQ/腾讯新闻 <a download> 增强）
   *   3. showSaveFilePicker（PC Chrome/Edge）
   *   4. <a download>（标准浏览器）
   *   5. 弹预览 + 长按保存（终极兜底）
   */
  _saveMedia(blob, filename, onDone) {
    const done = () => { if (onDone) onDone(); };
    const mimeType = blob.type || (filename.endsWith('.png') ? 'image/png' : 'video/mp4');
    const isImage = mimeType.startsWith('image/');
    // 清除环境缓存，强制重新检测
    this._envCache = null;
    const env = this._detectEnv();

    console.log('[保存] 环境:', JSON.stringify(env), 'isImage:', isImage, 'mime:', mimeType);

    // === 微信个人版（Android/鸿蒙/iOS 都走此路径）===
    if (env.isWxPersonal) {
      this._saveInWechat(blob, filename, isImage, done);
      return;
    }

    // === Android / 鸿蒙 腾讯新闻App / QQ / QQ浏览器：尝试 <a download>，失败弹预览 ===
    if (env.isAndroidLike && (env.isQQNews || env.isQQ || env.isQQBrowser || env.isTBS)) {
      this._saveInAndroidWebView(blob, filename, isImage, done);
      return;
    }

    // Windows 桌面端 和 微信环境 跳过 navigator.share
    if (!env.isWindows && !env.isWxPersonal && !env.isWxWork) {
      try {
        const file = new File([blob], filename, { type: mimeType });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          let shareSettled = false;
          // 超时保护：5 秒无响应则 fallback
          const shareTimeout = setTimeout(() => {
            if (!shareSettled) {
              shareSettled = true;
              console.warn('[保存] navigator.share 超时 5s，降级');
              this._fallbackSave(blob, filename, isImage, done);
            }
          }, 5000);
          navigator.share({ files: [file] }).then(() => {
            if (shareSettled) return;
            shareSettled = true;
            clearTimeout(shareTimeout);
            this._showToast('已保存');
            done();
          }).catch((err) => {
            if (shareSettled) return;
            shareSettled = true;
            clearTimeout(shareTimeout);
            if (err.name !== 'AbortError') {
              this._fallbackSave(blob, filename, isImage, done);
            } else {
              done(); // 用户主动取消
            }
          });
          return;
        }
      } catch (e) { /* 不支持，继续降级 */ }
    }

    // 走通用降级
    this._fallbackSave(blob, filename, isImage, done);
  }

  /**
   * Android 微信个人版专用保存
   * 图片：WeixinJSBridge.invoke('imagePreview') → 微信原生图片预览器 → 用户可直接长按保存到相册
   * 视频：弹预览 + 下载按钮（微信对视频无原生保存接口）
   */
  _saveInWechat(blob, filename, isImage, done) {
    // 此方法会被 index.html 内联补丁覆盖
    // 这里是 fallback：直接弹截屏保存界面
    const finish = () => { if (done) done(); };
    if (isImage) {
      this._showScreenshotSave(blob);
      finish();
    } else {
      this._showWechatVideoSave(blob, filename, finish);
    }
  }

  /**
   * 截屏保存界面（微信内终极兜底）
   * @param {Blob|string} blobOrUrl - 可以是 Blob 对象、blob URL 字符串或 data URL 字符串
   */
  _showScreenshotSave(blobOrUrl) {
    const old = document.getElementById('poster-overlay-wx');
    if (old) old.remove();

    // 兼容 Blob 对象 和 字符串 URL（data URL / blob URL）
    let imgSrc;
    let needRevoke = false;
    if (typeof blobOrUrl === 'string') {
      imgSrc = blobOrUrl; // data URL 或 blob URL 字符串直接用
    } else {
      imgSrc = URL.createObjectURL(blobOrUrl);
      needRevoke = true;
    }

    const overlay = document.createElement('div');
    overlay.id = 'poster-overlay-wx';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;';

    const img = document.createElement('img');
    img.style.cssText = 'max-width:100%;max-height:78vh;object-fit:contain;';
    img.src = imgSrc;
    overlay.appendChild(img);

    // 微信环境下尝试 WeixinJSBridge imagePreview（对 data URL 部分版本可行）
    const isDataUrl = typeof blobOrUrl === 'string' && blobOrUrl.startsWith('data:');
    const isWx = /MicroMessenger/i.test(navigator.userAgent);

    const bottomBar = document.createElement('div');
    bottomBar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.9));padding:20px 16px 30px;text-align:center;';
    bottomBar.innerHTML =
      '<p style="color:#ffd43b;font-size:17px;font-weight:bold;margin-bottom:12px;">长按图片保存，或截屏保存</p>' +
      '<div style="display:flex;justify-content:center;gap:12px;">' +
        (isWx && isDataUrl ? '<button id="wx-try-save-btn" style="padding:12px 28px;background:rgba(76,175,80,0.8);color:#fff;border:none;border-radius:25px;font-size:15px;">尝试保存到相册</button>' : '') +
        '<button id="wx-close-btn" style="padding:12px 28px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:25px;font-size:15px;">关闭</button>' +
      '</div>';
    overlay.appendChild(bottomBar);

    document.body.appendChild(overlay);

    // 关闭按钮
    bottomBar.querySelector('#wx-close-btn').addEventListener('click', () => {
      overlay.remove();
      if (needRevoke) URL.revokeObjectURL(imgSrc);
    });

    // 微信环境下的"尝试保存到相册"按钮
    const trySaveBtn = bottomBar.querySelector('#wx-try-save-btn');
    if (trySaveBtn) {
      trySaveBtn.addEventListener('click', () => {
        // 尝试 <a download>
        try {
          var a = document.createElement('a');
          a.href = imgSrc;
          a.download = 'flower_photo.jpg';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(function() { document.body.removeChild(a); }, 200);
        } catch(e) {
          console.warn('[微信保存] a.download 失败:', e);
        }
        this._showToast('如保存失败，请长按图片或截屏保存');
      });
    }
  }

  /**
   * 微信视频保存
   * 微信 WebView 中 <a download> 和 navigator.share 对视频均不可靠
   * 直接弹预览 + 提示用浏览器打开
   */
  _showWechatVideoSave(blob, filename, onDone) {
    console.log('[微信视频保存] 被调用, blob size:', blob.size, 'filename:', filename);
    this._showToast('正在打开视频预览...');
    this._showWechatVideoPreview(blob, filename, onDone);
  }

  /**
   * 微信视频预览保存界面
   * 微信中 <a download> 不生效，直接提示用户用浏览器打开
   * 同时提供"保存封面截图"作为替代
   */
  _showWechatVideoPreview(blob, filename, onDone) {
    const finish = () => { if (onDone) onDone(); };

    const oldOverlay = document.getElementById('save-preview-overlay');
    if (oldOverlay) oldOverlay.remove();

    const blobUrl = URL.createObjectURL(blob);
    // 封面截图（来自录像结束时的 poster）
    const posterSrc = this._lastFramePoster || '';

    const overlay = document.createElement('div');
    overlay.id = 'save-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.96);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = `
      <video style="max-width:92%;max-height:45vh;border-radius:8px;background:#000;touch-action:auto;" autoplay loop playsinline webkit-playsinline controls
        ${posterSrc ? `poster="${posterSrc}"` : ''}></video>
      <div style="background:rgba(255,200,50,0.15);border:1px solid rgba(255,200,50,0.4);border-radius:12px;padding:14px 20px;margin-top:16px;text-align:center;max-width:90%;">
        <p style="color:#ffd43b;font-size:15px;margin:0;line-height:1.8;font-weight:600;">
          微信内无法直接保存视频<br>
          请点击右上角 <span style="font-size:18px;">···</span> → <b>用浏览器打开</b>
        </p>
        <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:8px 0 0;line-height:1.6;">
          在浏览器中可直接下载保存视频
        </p>
      </div>
      <div style="display:flex;gap:12px;margin-top:16px;">
        ${posterSrc ? `<button class="wechat-save-poster" style="display:inline-flex;align-items:center;gap:6px;padding:12px 24px;background:rgba(255,255,255,0.95);color:#333;border:none;border-radius:25px;font-size:14px;font-weight:500;cursor:pointer;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          保存截图
        </button>` : ''}
        <button class="save-preview-close" style="padding:12px 28px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:25px;font-size:15px;">关闭</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const video = overlay.querySelector('video');
    video.src = blobUrl;
    video.play().catch(() => {});

    // 保存截图按钮（将视频封面作为图片保存）
    const posterBtn = overlay.querySelector('.wechat-save-poster');
    if (posterBtn && posterSrc) {
      posterBtn.addEventListener('click', () => {
        // 将 poster data URL 转成 blob 再走图片保存流程
        fetch(posterSrc).then(r => r.blob()).then(imgBlob => {
          const imgFilename = filename.replace(/\.\w+$/, '.jpg');
          this._showWechatImagePreview(posterSrc, imgBlob, imgFilename);
        }).catch(() => {
          this._showToast('截图保存失败');
        });
      });
    }

    const cleanup = () => {
      video.pause();
      video.src = '';
      overlay.remove();
      URL.revokeObjectURL(blobUrl);
      finish();
    };
    overlay.querySelector('.save-preview-close').addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
  }

  /**
   * Android 腾讯新闻App / QQ / QQ浏览器 专用保存
   * 策略：先尝试 <a download>（部分版本实际可用），500ms 后如果没成功再弹预览兜底
   */
  _saveInAndroidWebView(blob, filename, isImage, done) {
    const finish = () => { if (done) done(); };

    if (isImage) {
      // 图片保存：直接弹出增强型预览（含 <a download> 保存按钮 + 长按保存提示）
      this._showAndroidWebViewSaveDialog(blob, filename, true);
      finish();
    } else {
      // 视频保存：弹预览 + 下载按钮
      this._showSavePreview(blob, false);
      finish();
    }
  }

  /**
   * Android WebView 增强保存对话框（腾讯新闻/QQ/QQ浏览器）
   * 同时提供三种保存方式，确保至少一种能成功：
   *   1. 点击"保存"按钮触发 <a download>
   *   2. 长按图片保存
   *   3. 提示"用浏览器打开"
   */
  _showAndroidWebViewSaveDialog(blob, filename, isImage) {
    const oldOverlay = document.getElementById('save-preview-overlay');
    if (oldOverlay) oldOverlay.remove();

    const blobUrl = URL.createObjectURL(blob);

    const overlay = document.createElement('div');
    overlay.id = 'save-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.96);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;';

    if (isImage) {
      // 图片：同时转 base64（长按保存用）并提供 <a download> 按钮
      overlay.innerHTML = `
        <img class="webview-save-img" style="max-width:94%;max-height:62vh;border-radius:10px;object-fit:contain;touch-action:auto;-webkit-touch-callout:default;-webkit-user-select:auto;user-select:auto;" />
        <div style="display:flex;gap:12px;margin-top:20px;">
          <a class="webview-download-btn" download="${filename}" style="display:inline-flex;align-items:center;gap:6px;padding:12px 28px;background:rgba(255,255,255,0.95);color:#333;border:none;border-radius:25px;font-size:15px;font-weight:500;text-decoration:none;cursor:pointer;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            保存图片
          </a>
          <button class="save-preview-close" style="padding:12px 28px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:25px;font-size:15px;">关闭</button>
        </div>
        <p style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:14px;text-align:center;line-height:1.8;">
          点击保存按钮 或 长按图片保存<br>
          若均无效，可点右上角 <b style="color:rgba(255,255,255,0.8)">···</b> → <b style="color:rgba(255,255,255,0.8)">用浏览器打开</b>
        </p>
      `;
      document.body.appendChild(overlay);

      const img = overlay.querySelector('.webview-save-img');
      const downloadBtn = overlay.querySelector('.webview-download-btn');

      // 同时设置 blob URL 用于 <a download>
      downloadBtn.href = blobUrl;

      // 图片用 base64（长按保存兼容性更好）
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.readAsDataURL(blob);
    } else {
      // 视频（不太会走到这里，但保留兜底）
      this._showSavePreview(blob, false);
      return;
    }

    const cleanup = () => {
      overlay.remove();
      URL.revokeObjectURL(blobUrl);
    };
    overlay.querySelector('.save-preview-close').addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
  }

  /**
   * 通用降级保存（非特殊 WebView 环境）
   */
  _fallbackSave(blob, filename, isImage, done) {
    const finish = () => { if (done) done(); };

    // === showSaveFilePicker（PC Chrome 86+ / Edge 86+）===
    if (window.showSaveFilePicker) {
      const mimeType = blob.type || (isImage ? 'image/png' : 'video/mp4');
      const ext = filename.split('.').pop() || (isImage ? 'png' : 'mp4');
      const description = isImage ? '图片文件' : '视频文件';
      window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description,
          accept: { [mimeType]: ['.' + ext] },
        }],
      }).then(async (handle) => {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        this._showToast('已保存');
        finish();
      }).catch((err) => {
        if (err.name !== 'AbortError') {
          console.warn('showSaveFilePicker 失败，回退 <a download>:', err);
          this._aDownloadSave(blob, filename);
        }
        finish();
      });
      return;
    }

    // === <a download> ===
    this._aDownloadSave(blob, filename);
    finish();
  }

  /**
   * <a download> 方式保存文件
   * 创建隐藏的 <a> 标签，设置 blob URL 和 download 属性，模拟点击触发下载
   */
  _aDownloadSave(blob, filename) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      // 延迟清理，确保下载已触发
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
      this._showToast('已保存');
    } catch (e) {
      console.warn('<a download> 失败:', e);
      this._showToast('保存失败');
    }
  }

  _isMobileDevice() {
    return /Mobi|Android|iPhone|iPad|iPod|OpenHarmony|HarmonyOS/i.test(navigator.userAgent);
  }

  /**
   * 弹出保存预览（兜底方案）
   * 图片：blob → base64 Data URL，安卓 WebView 才能长按保存
   * 视频：提供下载按钮 + 长按提示双兜底
   */
  _showSavePreview(blob, isImage) {
    const oldOverlay = document.getElementById('save-preview-overlay');
    if (oldOverlay) oldOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'save-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;';

    // blob URL 用于视频播放和下载按钮
    let blobUrl = null;

    if (isImage) {
      // 图片：用 base64 Data URL，安卓 WebView 才支持长按保存
      overlay.innerHTML = `
        <p style="color:#fff;font-size:14px;margin-bottom:16px;text-align:center;line-height:1.7;opacity:0.85;">长按图片保存到相册</p>
        <img style="max-width:92%;max-height:70vh;border-radius:8px;object-fit:contain;touch-action:auto;-webkit-touch-callout:default;-webkit-user-select:auto;user-select:auto;" />
        <button class="save-preview-close" style="margin-top:24px;padding:12px 48px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:25px;font-size:15px;">关闭</button>
      `;
      document.body.appendChild(overlay);

      // blob → base64 Data URL（安卓 WebView 不支持 blob URL 长按保存）
      const reader = new FileReader();
      reader.onload = () => {
        overlay.querySelector('img').src = reader.result;
      };
      reader.readAsDataURL(blob);
    } else {
      // 视频：播放预览 + 下载按钮 + 长按提示
      blobUrl = URL.createObjectURL(blob);
      const ext = (blob.type || '').includes('webm') ? 'webm' : 'mp4';
      const filename = 'petals_' + Date.now() + '.' + ext;
      overlay.innerHTML = `
        <video style="max-width:92%;max-height:50vh;border-radius:8px;background:#000;touch-action:auto;" autoplay loop playsinline webkit-playsinline controls></video>
        <div style="display:flex;gap:12px;margin-top:20px;">
          <a class="save-preview-download" download="${filename}" style="display:inline-flex;align-items:center;gap:6px;padding:12px 32px;background:rgba(255,255,255,0.95);color:#333;border:none;border-radius:25px;font-size:15px;font-weight:500;text-decoration:none;cursor:pointer;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            保存视频
          </a>
          <button class="save-preview-close" style="padding:12px 32px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:25px;font-size:15px;cursor:pointer;">关闭</button>
        </div>
        <p style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:14px;text-align:center;line-height:1.7;">
          若点击保存无反应，可长按视频选择保存<br>
          或点击右上角 <b style="color:rgba(255,255,255,0.8)">···</b> → <b style="color:rgba(255,255,255,0.8)">用浏览器打开</b>
        </p>
      `;
      document.body.appendChild(overlay);
      const video = overlay.querySelector('video');
      video.src = blobUrl;
      video.play().catch(() => {});

      // 下载按钮绑定 blob URL
      const downloadBtn = overlay.querySelector('.save-preview-download');
      downloadBtn.href = blobUrl;
    }

    const cleanup = () => {
      if (!isImage) {
        const v = overlay.querySelector('video');
        if (v) { v.pause(); v.src = ''; }
      }
      overlay.remove();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
    overlay.querySelector('.save-preview-close').addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup();
    });
  }

  _savePhoto(blob, filename, onDone) {
    this._saveMedia(blob, filename, onDone);
  }

  // ============================================
  // 录像
  // ============================================
  toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  startRecording() {
    // 录像用 1x 分辨率，避免性能瓶颈
    this._updateCanvasSize();

    const tier = this.deviceTier || 'high';

    // 根据设备等级调整 captureStream 帧率
    const streamFps = tier === 'low' ? 15 : 24;

    // 从合成 canvas 获取媒体流
    const stream = this.compositeCanvas.captureStream(streamFps);

    // 选择编码格式（优先 mp4，兼容性更好）
    const mimeTypes = [
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    let selectedMime = '';
    for (const mime of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mime)) {
        selectedMime = mime;
        break;
      }
    }

    if (!selectedMime) {
      this._showToast('当前浏览器不支持录像');
      return;
    }

    // 根据设备等级调整码率：low=2Mbps, medium=4Mbps, high=6Mbps
    const bitrate = tier === 'low' ? 2000000 : (tier === 'medium' ? 4000000 : 6000000);

    try {
      this.recordedChunks = [];
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: selectedMime,
        videoBitsPerSecond: bitrate,
      });

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this._saveRecording();
      };

      this.mediaRecorder.onerror = () => {
        this._showToast('录像出错');
        this._resetRecordingUI();
      };

      // === 方案A: 录像时花瓣降低 ===
      // low 档降到 50%，medium 降到 65%，high 降到 80%
      const ps = this.particleSystem;
      if (ps && ps.petalData) {
        this._preRecordPetalCount = ps.petalData.length;
        const petalRatio = tier === 'low' ? 0.5 : (tier === 'medium' ? 0.65 : 0.8);
        const reducedCount = Math.round(this._preRecordPetalCount * petalRatio);
        ps.setPetalCount(reducedCount);
        console.log(`[录像] 花瓣数: ${this._preRecordPetalCount} → ${reducedCount} (${tier})`);
      }

      // === 合成跳帧：low/medium 档每 2 帧合成一次 ===
      this._preRecordCompositeInterval = this._compositeInterval;
      if (tier === 'low' || tier === 'medium') {
        this._compositeInterval = 2;
      }

      // === 方案C: 录像时降低分割蒙版分辨率 ===
      // low 档: 256（比320更小），medium/high: 320
      if (this.segmentation) {
        this._preRecordMaskRes = this.segmentation.maskResolution;
        const maskRes = tier === 'low' ? 256 : 320;
        this.segmentation.maskResolution = maskRes;
        console.log(`[录像] 蒙版分辨率: ${this._preRecordMaskRes} → ${maskRes} (${tier})`);
      }

      // 先设 isRecording，再合成一帧，确保第一帧不是黑色
      this.isRecording = true;
      this._compositeCounter = 0; // 重置帧率节流计数器
      this._composite();

      this.mediaRecorder.start(100); // 每 100ms 收集一次数据
      this.recordingStartTime = Date.now();

      // 更新 UI
      this.$btnRecord.classList.add('recording');
      this.$recordTime.classList.remove('hidden');
      this._updateRecordingTime();

      // 录像中禁用摄像头切换/开关按钮
      this._setCameraButtonsDisabled(true);

      // 每帧合成画面给录像流
      this._startCompositeLoop();

      this._showToast('开始录像');
    } catch (err) {
      console.error('录像启动失败:', err);
      this.isRecording = false;
      this._showToast('录像失败: ' + (err.message || err));
    }
  }

  stopRecording() {
    // 截取最后一帧作为预览 poster（在 stop 之前，canvas 还有内容）
    try {
      this._lastFramePoster = this.compositeCanvas.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      this._lastFramePoster = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.isRecording = false;

    // === 方案A: 恢复录像前的花瓣数量 ===
    if (this._preRecordPetalCount && this.particleSystem) {
      this.particleSystem.setPetalCount(this._preRecordPetalCount);
      console.log(`[录像结束] 花瓣数恢复: ${this._preRecordPetalCount}`);
      this._preRecordPetalCount = null;
    }

    // 恢复合成跳帧间隔
    if (this._preRecordCompositeInterval !== undefined) {
      this._compositeInterval = this._preRecordCompositeInterval;
      this._preRecordCompositeInterval = undefined;
    }

    // === 方案B: 恢复录像前的分割频率 ===
    if (this._preRecordFrameSkip !== null && this.segmentation) {
      this.segmentation.frameSkip = this._preRecordFrameSkip;
      console.log(`[录像结束] 分割帧跳恢复: ${this._preRecordFrameSkip}`);
      this._preRecordFrameSkip = null;
    }

    // === 方案C: 恢复录像前的蒙版分辨率 ===
    if (this._preRecordMaskRes && this.segmentation) {
      this.segmentation.maskResolution = this._preRecordMaskRes;
      console.log(`[录像结束] 蒙版分辨率恢复: ${this._preRecordMaskRes}`);
      this._preRecordMaskRes = null;
    }

    this._resetRecordingUI();
    this._updateCanvasSize(); // 恢复高清分辨率
    // 录像结束，恢复摄像头按钮
    this._setCameraButtonsDisabled(false);
    this._showToast('正在保存视频...');
  }

  _startCompositeLoop() {
    // 不再需要独立循环 — 由花瓣系统在每帧渲染完成后调用 onFrameReady()
    // 保留空方法以兼容调用
  }

  /**
   * 花瓣系统每帧渲染完成后调用此方法（2D canvas 内容已就绪）
   * 1-pass + 0.75x 优化后合成开销大幅减轻，每帧都合成
   */
  onFrameReady() {
    if (!this.isRecording) return;
    this._compositeCounter++;
    if (this._compositeCounter < this._compositeInterval) return;
    this._compositeCounter = 0;
    this._composite();
  }

  _updateRecordingTime() {
    if (!this.isRecording) return;
    const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
    const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const sec = String(elapsed % 60).padStart(2, '0');
    this.$recordTime.textContent = `${min}:${sec}`;
    requestAnimationFrame(() => this._updateRecordingTime());
  }

  _saveRecording() {
    if (this.recordedChunks.length === 0) {
      this._showToast('录像数据为空');
      return;
    }

    const mimeType = this.recordedChunks[0].type || 'video/mp4';
    const blob = new Blob(this.recordedChunks, { type: mimeType });

    // blob 有效性检查：小于 10KB 视为录像失败
    if (blob.size < 10240) {
      console.warn(`[录像] blob 过小(${blob.size}B)，可能录像失败`);
      this._showToast('录像失败，请重试');
      return;
    }

    const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
    const filename = 'petals_' + this._timestamp() + '.' + ext;

    this._showVideoPreviewNew(blob, filename);
  }

  /**
   * 录像预览：近全屏带圆角边框，视频可播放，底部保存/重录按钮
   * 微信兼容：blob URL 视频可能黑屏，先显示 poster 截图兜底
   */
  _showVideoPreviewNew(blob, filename) {
    const videoUrl = URL.createObjectURL(blob);
    const posterSrc = this._lastFramePoster || '';

    // 清理之前的预览
    const oldOverlay = document.getElementById('video-preview-overlay-new');
    if (oldOverlay) oldOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'video-preview-overlay-new';
    overlay.className = 'photo-preview-overlay';
    overlay.innerHTML = `
      <div class="photo-preview-frame">
        ${posterSrc ? `<img class="video-preview-poster" src="${posterSrc}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;z-index:1;">` : ''}
        <video class="video-preview-player-new" loop muted playsinline webkit-playsinline preload="auto"
          ${posterSrc ? `poster="${posterSrc}"` : ''}
          style="position:relative;z-index:2;"></video>
        <div class="video-play-hint" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:3;display:flex;align-items:center;justify-content:center;cursor:pointer;">
          <div style="width:64px;height:64px;border-radius:50%;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><polygon points="6,3 20,12 6,21"/></svg>
          </div>
        </div>
      </div>
      <div class="photo-preview-actions">
        <button class="photo-preview-btn" id="video-preview-discard">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          <span>丢弃</span>
        </button>
        <button class="photo-preview-btn photo-preview-btn-primary" id="video-preview-save">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>保存</span>
        </button>
      </div>
    `;
    document.body.appendChild(overlay);

    const video = overlay.querySelector('.video-preview-player-new');
    const posterImg = overlay.querySelector('.video-preview-poster');
    const playHint = overlay.querySelector('.video-play-hint');

    // 视频播放成功后隐藏 poster 图片和播放按钮
    let videoPlaying = false;
    const onVideoPlaying = () => {
      if (videoPlaying) return;
      videoPlaying = true;
      if (posterImg) posterImg.style.display = 'none';
      if (playHint) playHint.style.display = 'none';
    };
    video.addEventListener('playing', onVideoPlaying);
    // timeupdate 也能检测到（某些浏览器 playing 事件不可靠）
    video.addEventListener('timeupdate', function onTU() {
      if (video.currentTime > 0.05) {
        onVideoPlaying();
        video.removeEventListener('timeupdate', onTU);
      }
    });

    // 点击播放按钮 / 视频区域 → 手动播放（解决移动端自动播放限制）
    const manualPlay = (e) => {
      e.preventDefault();
      e.stopPropagation();
      video.play().catch(() => {});
    };
    if (playHint) playHint.addEventListener('click', manualPlay);
    if (playHint) playHint.addEventListener('touchend', manualPlay);

    video.src = videoUrl;
    video.load();

    const tryPlay = () => {
      video.play().catch(() => {});
    };

    // 多事件监听
    video.addEventListener('canplay', tryPlay, { once: true });
    video.addEventListener('loadeddata', tryPlay, { once: true });

    if (video.readyState >= 3) {
      tryPlay();
    }

    // 多轮兜底重试
    [300, 800, 1500, 3000, 5000].forEach(delay => {
      setTimeout(() => {
        if (video.paused) video.play().catch(() => {});
      }, delay);
    });

    // 入场动效
    requestAnimationFrame(() => {
      overlay.classList.add('show');
    });

    // 关闭预览
    const cleanup = () => {
      overlay.classList.add('photo-preview-exit');
      video.pause();
      setTimeout(() => {
        overlay.remove();
        URL.revokeObjectURL(videoUrl);
      }, 300);
    };

    // 丢弃（click + touchend 双绑，iOS 兼容）
    let discardDone = false;
    const discardHandler = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (discardDone) return; discardDone = true;
      cleanup();
    };
    overlay.querySelector('#video-preview-discard').addEventListener('click', discardHandler);
    overlay.querySelector('#video-preview-discard').addEventListener('touchend', discardHandler);

    // 保存（click + touchend 双绑）
    // 注意：不调用 e.preventDefault()，避免消耗 user activation 导致 PC Chrome <a download> 被拦截
    let saveDone = false;
    const saveHandler = (e) => {
      e.stopPropagation();
      if (saveDone) return; saveDone = true;
      this._saveMedia(blob, filename, cleanup);
    };
    overlay.querySelector('#video-preview-save').addEventListener('click', saveHandler);
    overlay.querySelector('#video-preview-save').addEventListener('touchend', saveHandler);
  }

  _resetRecordingUI() {
    this.$btnRecord.classList.remove('recording');
    this.$recordTime.classList.add('hidden');
    this.$recordTime.textContent = '00:00';
  }

  /**
   * 录像时禁用/启用摄像头切换和开关按钮
   */
  _setCameraButtonsDisabled(disabled) {
    const btnSwitch = document.getElementById('btn-switch-camera');
    const btnToggle = document.getElementById('btn-toggle-camera');
    [btnSwitch, btnToggle].forEach(btn => {
      if (!btn) return;
      if (disabled) {
        btn.classList.add('ui-btn-disabled');
        btn.style.pointerEvents = 'none';
      } else {
        btn.classList.remove('ui-btn-disabled');
        btn.style.pointerEvents = '';
      }
    });
  }

  // ============================================
  // 辅助
  // ============================================
  _timestamp() {
    const d = new Date();
    return d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '_' +
      String(d.getHours()).padStart(2, '0') +
      String(d.getMinutes()).padStart(2, '0') +
      String(d.getSeconds()).padStart(2, '0');
  }

  _showToast(msg) {
    if (!this.$toast) return;
    this.$toast.textContent = msg;
    this.$toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.$toast.classList.remove('show');
    }, 2000);
  }

  destroy() {
    if (this.isRecording) this.stopRecording();
  }
}
