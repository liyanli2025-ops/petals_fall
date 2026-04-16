/**
 * 人体分割模块 v3
 * 使用 MediaPipe SelfieSegmentation 从摄像头画面中提取人物轮廓
 * 将人物区域绘制到独立 canvas 上，实现人物遮挡花瓣效果
 * 
 * v3 修复：
 *   - 彻底消除 PC 端残影：非分割帧不再用旧蒙版重绘
 *   - 蒙版 RGB 亮度阈值二值化，消除边缘半透明残留
 *   - update() 非阻塞（fire-and-forget），processing 锁防重复
 */
class PersonSegmentation {
  constructor() {
    this.canvas = document.getElementById('canvas-person');
    this.ctx = this.canvas.getContext('2d');
    this.video = document.getElementById('camera-video');
    this.segmenter = null;
    this.running = false;
    this.ready = false;
    this.processing = false; // 防止重复 send
    this.lastMask = null;
    this.frameSkip = 0;
    this.frameCount = 0;
    
    // 碰撞检测器引用（外部注入）
    this.bodyCollision = null;
    
    // 蒙版处理用的中间 canvas
    this._maskCanvas = null;
    this._maskCtx = null;

    // 蒙版分辨率上限（默认 480，录像时可降到 320 以提升性能）
    this.maskResolution = 480;
  }

  async init() {
    if (typeof SelfieSegmentation === 'undefined') {
      console.warn('MediaPipe SelfieSegmentation 未加载，人物遮挡功能不可用');
      return false;
    }

    try {
      this.segmenter = new SelfieSegmentation({
        locateFile: (file) => {
          const href = window.location.href;
          if (href.includes('qq.com') || href.includes('gtimg.com')) {
            const cdnBase = 'https://mat1.gtimg.com/qqcdn/redian/petals_fall_test/libs/mediapipe/';
            return cdnBase + file;
          }
          return `libs/mediapipe/${file}`;
        }
      });

      this.segmenter.setOptions({
        modelSelection: 1,
        selfieMode: false,
      });

      this.segmenter.onResults((results) => {
        this.processing = false;
        this._onSegmentationResult(results);
      });

      this._resize();
      window.addEventListener('resize', () => this._resize());

      this.ready = true;
      const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
      this.frameSkip = isMobile ? 3 : 1;

      console.log('人体分割模块初始化成功');
      return true;
    } catch (err) {
      console.warn('人体分割初始化失败:', err);
      return false;
    }
  }

  _resize() {
    // canvas 的内部分辨率在 _drawMask 中动态设为视频原始分辨率
  }

  /**
   * 每帧调用 — 非阻塞
   * 关键改动：非分割帧 **不重绘蒙版**，只在收到新结果时绘制
   * 这样避免旧蒙版+新视频帧错配导致的残影
   */
  update() {
    if (!this.ready || !this.running) return;
    if (this.video.readyState < 2) return;

    this.frameCount++;

    // 非分割帧：不做任何事（保持上次绘制的结果）
    // 旧版在此处用 lastMask 重绘，会导致旧蒙版+新视频帧错配 → 残影
    if (this.frameCount % this.frameSkip !== 0) {
      return;
    }

    // 上一次 send 还没返回结果，跳过
    if (this.processing) {
      return;
    }

    this.processing = true;
    this.segmenter.send({ image: this.video }).catch(() => {
      this.processing = false;
    });
  }

  _onSegmentationResult(results) {
    if (!results.segmentationMask) return;
    this.lastMask = results.segmentationMask;
    this._drawMask(results.segmentationMask);
    
    if (this.bodyCollision) {
      const vw = this.video.videoWidth || 0;
      const vh = this.video.videoHeight || 0;
      this.bodyCollision.updateFromMask(results.segmentationMask, vw, vh);
    }
  }

  /**
   * 将人物区域绘制为遮挡层
   * 
   * 蒙版处理流程：
   *   1. 将蒙版绘制到低分辨率中间 canvas
   *   2. 对 RGB 亮度做阈值二值化（消除边缘半透明 → 消除残影）
   *   3. 将处理后的蒙版拉伸绘制到主 canvas
   *   4. source-in 模式用视频帧填充人物区域
   */
  _drawMask(mask) {
    const ctx = this.ctx;
    const vw = this.video.videoWidth || this.canvas.width;
    const vh = this.video.videoHeight || this.canvas.height;

    if (this.canvas.width !== vw || this.canvas.height !== vh) {
      this.canvas.width = vw;
      this.canvas.height = vh;
    }

    ctx.clearRect(0, 0, vw, vh);

    if (this.video.readyState < 2) return;

    // 中间 canvas 做蒙版阈值处理
    if (!this._maskCanvas) {
      this._maskCanvas = document.createElement('canvas');
      this._maskCtx = this._maskCanvas.getContext('2d', { willReadFrequently: true });
    }
    const maxRes = this.maskResolution;
    const mw = Math.min(vw, maxRes);
    const mh = Math.min(vh, Math.round(maxRes * vh / vw));
    if (this._maskCanvas.width !== mw || this._maskCanvas.height !== mh) {
      this._maskCanvas.width = mw;
      this._maskCanvas.height = mh;
    }
    const mctx = this._maskCtx;
    mctx.clearRect(0, 0, mw, mh);
    mctx.drawImage(mask, 0, 0, mw, mh);

    // 阈值二值化：基于 RGB 亮度（MediaPipe 蒙版用 RGB 表示置信度）
    // 亮度 < 阈值的边缘像素全部清零，消除半透明残留
    const imageData = mctx.getImageData(0, 0, mw, mh);
    const data = imageData.data;
    const threshold = 128;
    for (let i = 0; i < data.length; i += 4) {
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (brightness < threshold) {
        data[i] = 0;     // R
        data[i + 1] = 0; // G
        data[i + 2] = 0; // B
        data[i + 3] = 0; // A
      }
    }
    mctx.putImageData(imageData, 0, 0);

    // 将处理后的蒙版绘制到主 canvas
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this._maskCanvas, 0, 0, vw, vh);

    // source-in 模式，用视频帧填充人物区域
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(this.video, 0, 0, vw, vh);

    ctx.globalCompositeOperation = 'source-over';
  }

  start() {
    this.running = true;
  }

  stop() {
    this.running = false;
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  destroy() {
    this.stop();
    this.lastMask = null;
    if (this.segmenter) {
      this.segmenter.close();
    }
  }
}
