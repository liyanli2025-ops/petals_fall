/**
 * 人体分割模块 v2
 * 使用 MediaPipe SelfieSegmentation 从摄像头画面中提取人物轮廓
 * 将人物区域绘制到独立 canvas 上，实现人物遮挡花瓣效果
 * 
 * v2 修复：
 *   - update() 改为非阻塞（fire-and-forget），不再 await send()
 *   - 添加 processing 锁防止重复发送导致堆积
 *   - _drawMask 每帧从 video 实时取画面，不缓存旧帧
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
  }

  async init() {
    if (typeof SelfieSegmentation === 'undefined') {
      console.warn('MediaPipe SelfieSegmentation 未加载，人物遮挡功能不可用');
      return false;
    }

    try {
      this.segmenter = new SelfieSegmentation({
        locateFile: (file) => {
          return `libs/mediapipe/${file}`;
        }
      });

      this.segmenter.setOptions({
        modelSelection: 1,
        selfieMode: false,
      });

      this.segmenter.onResults((results) => {
        this.processing = false; // 释放锁
        this._onSegmentationResult(results);
      });

      this._resize();
      window.addEventListener('resize', () => this._resize());

      this.ready = true;
      const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
      this.frameSkip = isMobile ? 3 : 2; // 降低分割频率，优先保证花瓣流畅

      console.log('人体分割模块初始化成功');
      return true;
    } catch (err) {
      console.warn('人体分割初始化失败:', err);
      return false;
    }
  }

  _resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  /**
   * 每帧调用 — 非阻塞！
   * 不 await send()，而是 fire-and-forget，结果通过 onResults 回调处理
   */
  update() {
    if (!this.ready || !this.running) return;
    if (this.video.readyState < 2) return;

    this.frameCount++;

    // 非分割帧：用上次遮罩 + 当前视频帧重绘（保持同步）
    if (this.frameCount % this.frameSkip !== 0) {
      if (this.lastMask) this._drawMask(this.lastMask);
      return;
    }

    // 上一次 send 还没返回结果，跳过，避免堆积
    if (this.processing) {
      if (this.lastMask) this._drawMask(this.lastMask);
      return;
    }

    // 发射 send，不等待结果
    this.processing = true;
    this.segmenter.send({ image: this.video }).catch(() => {
      this.processing = false;
    });
  }

  _onSegmentationResult(results) {
    if (!results.segmentationMask) return;
    this.lastMask = results.segmentationMask;
    this._drawMask(results.segmentationMask);
  }

  /**
   * 将人物区域从摄像头画面中抠出来，绘制到人物遮罩 canvas
   * 关键：始终从 this.video 实时取帧，不会残留旧画面
   */
  _drawMask(mask) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // 彻底清空
    ctx.clearRect(0, 0, w, h);

    // 确保 video 有画面
    if (this.video.readyState < 2) return;

    // 第一步：画遮罩（白色=人物，黑色=背景）
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(mask, 0, 0, w, h);

    // 第二步：source-in 模式，只保留人物区域的当前视频帧
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(this.video, 0, 0, w, h);

    // 重置合成模式
    ctx.globalCompositeOperation = 'source-over';
  }

  start() {
    this.running = true;
  }

  stop() {
    this.running = false;
    // 清空 canvas，防止最后一帧残留
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
