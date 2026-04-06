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

    // 外部注入 CameraManager 引用（用于判断前置/后置）
    this.cameraManager = null;

    // 外部注入 PetalParticleSystem 引用（拍照时临时提升 DPR）
    this.particleSystem = null;

    // === 运动模糊（多帧累积） ===
    // 保存最近 N 帧的花瓣层快照，合成时叠加产生拖影
    this._motionBlurFrames = 3;         // 保留历史帧数
    this._petalHistoryBuffers = [];     // ring buffer: 离屏 canvas 数组
    this._historyWriteIndex = 0;        // 当前写入位置
    this._historyFilled = 0;            // 已填充的帧数
    this._motionBlurInited = false;
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

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    // 拍照时用高清分辨率，录像时重新设置为 1x
    this._updateCanvasSize();
  }

  _updateCanvasSize() {
    const dpr = this.isRecording ? 1 : Math.min(window.devicePixelRatio || 1, 3);
    this.compositeCanvas.width = window.innerWidth * dpr;
    this.compositeCanvas.height = window.innerHeight * dpr;
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

    // === 录像时：与拍照相同的完整模糊流程（黑屏已通过同步合成解决） ===
    if (this.isRecording) {
      // 2. 远景花瓣层（完整高斯模糊，与拍照一致）
      if (this.canvasFar.width > 0) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        this._drawBlurred(ctx, this.canvasFar, w, h, 2.5 * compositeDPR);
        ctx.restore();
      }

      // 3. 人物遮罩层 — 遮挡远景花瓣，保持人在远景前面
      this._drawPersonMask(ctx, w, h);

      // 4. 中景花瓣层（清晰，素材已预处理去边）
      if (this.canvasMid.width > 0) {
        ctx.drawImage(this.canvasMid, 0, 0, w, h);
      }

      // 5. 近景花瓣层（完整高斯模糊，与拍照一致）
      if (this.canvasNear.width > 0) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        this._drawBlurred(ctx, this.canvasNear, w, h, 4 * compositeDPR);
        ctx.restore();
      }
      return;
    }

    // === 非录像（拍照）时：完整运动模糊流程 ===

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

    // 5. 人物遮罩层 — 拍照合成时已在远景后绘制，此处无需重复

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
   * 轻量缩放模糊（录像用）— 不走 WebGL，纯 Canvas 2D 缩小再放大
   * 性能 ~1-2ms，适合录像时对远景层做轻度虚化
   */
  _drawScaleBlur(ctx, sourceCanvas, w, h, blurRadius) {
    if (!this._scaleBlurCanvas) {
      this._scaleBlurCanvas = document.createElement('canvas');
      this._scaleBlurCtx = this._scaleBlurCanvas.getContext('2d');
    }
    // 缩小比例：blur 越大缩得越小
    const scale = Math.max(0.08, 1 / (1 + blurRadius * 1.5));
    const sw = Math.max(4, Math.floor(w * scale));
    const sh = Math.max(4, Math.floor(h * scale));
    this._scaleBlurCanvas.width = sw;
    this._scaleBlurCanvas.height = sh;
    this._scaleBlurCtx.imageSmoothingEnabled = true;
    this._scaleBlurCtx.imageSmoothingQuality = 'high';
    // 缩小
    this._scaleBlurCtx.drawImage(sourceCanvas, 0, 0, sw, sh);
    // 放大回原尺寸 — 双线性插值自然产生模糊效果
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._scaleBlurCanvas, 0, 0, sw, sh, 0, 0, w, h);
  }

  /**
   * 两级柔和缩放模糊（录像近景层专用）
   * 先缩到 50%，再缩到 25%，最后放大回原尺寸
   * 每级缩放都很温和（只 2x），不会破坏边缘半透明像素
   * 效果接近 blur(3-4px)，无锯齿
   */
  _drawSoftScaleBlur(ctx, sourceCanvas, w, h) {
    if (!this._softBlurCanvas1) {
      this._softBlurCanvas1 = document.createElement('canvas');
      this._softBlurCtx1 = this._softBlurCanvas1.getContext('2d');
    }
    if (!this._softBlurCanvas2) {
      this._softBlurCanvas2 = document.createElement('canvas');
      this._softBlurCtx2 = this._softBlurCanvas2.getContext('2d');
    }

    // 第一级：缩到 50%
    const w1 = Math.max(4, Math.floor(w * 0.5));
    const h1 = Math.max(4, Math.floor(h * 0.5));
    this._softBlurCanvas1.width = w1;
    this._softBlurCanvas1.height = h1;
    this._softBlurCtx1.imageSmoothingEnabled = true;
    this._softBlurCtx1.imageSmoothingQuality = 'high';
    this._softBlurCtx1.drawImage(sourceCanvas, 0, 0, w1, h1);

    // 第二级：再缩到 25%
    const w2 = Math.max(4, Math.floor(w * 0.25));
    const h2 = Math.max(4, Math.floor(h * 0.25));
    this._softBlurCanvas2.width = w2;
    this._softBlurCanvas2.height = h2;
    this._softBlurCtx2.imageSmoothingEnabled = true;
    this._softBlurCtx2.imageSmoothingQuality = 'high';
    this._softBlurCtx2.drawImage(this._softBlurCanvas1, 0, 0, w1, h1, 0, 0, w2, h2);

    // 放大回原尺寸
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._softBlurCanvas2, 0, 0, w2, h2, 0, 0, w, h);
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
    const isMobileShot = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
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

    try {
      // 预缓存花瓣层历史帧（仅 PC 端，移动端跳过以加速）
      if (!this.isRecording && !isMobileShot) {
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

    // 导出 blob → 弹出预览界面
    try {
      this.compositeCanvas.toBlob((blob) => {
        if (!blob) {
          this._showToast('拍照失败: 图片生成为空');
          return;
        }
        // 拍照后先弹预览，用户再选择保存/分享/关闭
        this._showPhotoPreview(blob, filename);
      }, imgFormat, isMobileShot ? 0.92 : undefined);
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

    // 清理之前的预览
    const oldOverlay = document.getElementById('photo-preview-overlay');
    if (oldOverlay) oldOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'photo-preview-overlay';
    overlay.className = 'photo-preview-overlay';
    overlay.innerHTML = `
      <div class="photo-preview-frame">
        <img class="photo-preview-img" />
      </div>
      <div class="photo-preview-actions">
        <button class="photo-preview-btn" id="photo-preview-retake">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          <span>重拍</span>
        </button>
        <button class="photo-preview-btn photo-preview-btn-primary" id="photo-preview-save">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>保存</span>
        </button>
      </div>
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

    // 保存（click + touchend 双绑）
    let saveDone = false;
    const saveHandler = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (saveDone) return; saveDone = true;
      this._savePhoto(blob, filename, cleanup);
    };
    overlay.querySelector('#photo-preview-save').addEventListener('click', saveHandler);
    overlay.querySelector('#photo-preview-save').addEventListener('touchend', saveHandler);
  }

  /**
   * 检测是否在微信浏览器中
   */
  _isWechat() {
    return /MicroMessenger/i.test(navigator.userAgent);
  }

  /**
   * 保存照片/视频 — 统一优先级链（所有环境一致）
   * 
   * 优先级：
   *   1. navigator.share (files) → 保存到相册（最优）
   *   2. <a download> → 保存到手机文件（次优）
   *   3. 弹预览 + 操作指引 → 兜底
   * 
   * 注意：微信个人版不支持 share 也不支持 download，直接走兜底
   */
  _saveMedia(blob, filename, onDone) {
    const done = () => { if (onDone) onDone(); };
    const mimeType = blob.type || (filename.endsWith('.png') ? 'image/png' : 'video/mp4');
    const isImage = mimeType.startsWith('image/');
    const isWxPersonal = this._isWechat() && !/wxwork/i.test(navigator.userAgent);

    // === 优先级 1：navigator.share → 保存到相册 ===
    // 所有环境都尝试（微信个人版也试一下，万一以后支持了）
    try {
      const file = new File([blob], filename, { type: mimeType });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        done();
        navigator.share({ files: [file] }).then(() => {
          this._showToast('已保存');
        }).catch((err) => {
          if (err.name !== 'AbortError') {
            // share 失败，走后续降级
            this._fallbackSave(blob, filename, isImage, isWxPersonal);
          }
        });
        return;
      }
    } catch (e) { /* 不支持，继续降级 */ }

    // share 不可用，走降级
    this._fallbackSave(blob, filename, isImage, isWxPersonal);
    done();
  }

  /**
   * share 不可用时的降级保存
   */
  _fallbackSave(blob, filename, isImage, isWxPersonal) {
    // === 优先级 2：<a download> → 保存到手机 ===
    // 微信个人版的 <a download> 会跳到空白页，不可用，跳过
    if (!isWxPersonal) {
      // 尝试 download，大部分浏览器（PC + Android Chrome/Firefox + 企微等）有效
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this._showToast('已保存到文件');
      return;
    }

    // === 优先级 3：弹预览 + 指引（仅微信个人版会走到这里）===
    this._showSavePreview(blob, isImage);
  }

  _isMobileDevice() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  /**
   * 弹出保存预览（微信个人版兜底）
   */
  _showSavePreview(blob, isImage) {
    const url = URL.createObjectURL(blob);
    const oldOverlay = document.getElementById('save-preview-overlay');
    if (oldOverlay) oldOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'save-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;';

    if (isImage) {
      // 微信个人版：图片支持长按保存
      overlay.innerHTML = `
        <p style="color:#fff;font-size:14px;margin-bottom:16px;text-align:center;line-height:1.7;opacity:0.85;">长按图片保存到相册</p>
        <img style="max-width:92%;max-height:70vh;border-radius:8px;object-fit:contain;" />
        <button class="save-preview-close" style="margin-top:24px;padding:12px 48px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:25px;font-size:15px;">关闭</button>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('img').src = url;
    } else {
      // 微信个人版：视频无法直接保存
      overlay.innerHTML = `
        <video style="max-width:92%;max-height:60vh;border-radius:8px;background:#000;" autoplay loop playsinline webkit-playsinline controls></video>
        <p style="color:rgba(255,255,255,0.75);font-size:13px;margin-top:16px;text-align:center;line-height:1.8;">
          微信内暂不支持直接保存视频<br>
          请点击右上角 <b style="color:#fff">···</b> → <b style="color:#fff">用浏览器打开</b><br>
          在浏览器中可直接保存
        </p>
        <button class="save-preview-close" style="margin-top:20px;padding:12px 48px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:25px;font-size:15px;">关闭</button>
      `;
      document.body.appendChild(overlay);
      const video = overlay.querySelector('video');
      video.src = url;
      video.play().catch(() => {});
    }

    const cleanup = () => {
      if (!isImage) {
        const v = overlay.querySelector('video');
        if (v) v.pause();
      }
      overlay.remove();
      URL.revokeObjectURL(url);
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

    // 从合成 canvas 获取媒体流
    const stream = this.compositeCanvas.captureStream(24);

    // 尝试添加音频（如果摄像头有音频轨道）
    // 本项目 audio: false，所以一般没有音频

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

    try {
      this.recordedChunks = [];
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: selectedMime,
        videoBitsPerSecond: 6000000, // 6Mbps — 提高编码质量减少压缩卡顿感
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

      // 先设 isRecording，再合成一帧，确保第一帧不是黑色
      this.isRecording = true;
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
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.isRecording = false;
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
   * 这样合成时 canvasFar/canvasMid/canvasNear 一定有内容，不会黑屏
   */
  onFrameReady() {
    if (!this.isRecording) return;
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
    const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
    const filename = 'petals_' + this._timestamp() + '.' + ext;

    this._showVideoPreviewNew(blob, filename);
  }

  /**
   * 录像预览：近全屏带圆角边框，视频可播放，底部保存/重录按钮
   */
  _showVideoPreviewNew(blob, filename) {
    const videoUrl = URL.createObjectURL(blob);

    // 清理之前的预览
    const oldOverlay = document.getElementById('video-preview-overlay-new');
    if (oldOverlay) oldOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'video-preview-overlay-new';
    overlay.className = 'photo-preview-overlay';
    overlay.innerHTML = `
      <div class="photo-preview-frame">
        <video class="video-preview-player-new" loop muted playsinline webkit-playsinline preload="auto"></video>
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
    video.src = videoUrl;
    video.load(); // 强制触发加载（iOS Safari 对 blob URL 需要显式 load）

    // iOS Safari blob URL 视频播放策略：
    // 不做 currentTime seek hack（在某些 iOS 版本上反而导致黑屏）
    // 直接 play()，通过多事件 + 多次重试确保播放成功
    const tryPlay = () => {
      video.play().catch(() => {});
    };

    // 多事件监听，取最先触发的
    video.addEventListener('canplay', tryPlay, { once: true });
    video.addEventListener('loadeddata', tryPlay, { once: true });

    // 如果 readyState 已足够，直接播放
    if (video.readyState >= 3) {
      tryPlay();
    }

    // 多轮兜底重试（无条件尝试，不检查 readyState）
    [500, 1500, 3000, 5000].forEach(delay => {
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
    let saveDone = false;
    const saveHandler = (e) => {
      e.preventDefault(); e.stopPropagation();
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
