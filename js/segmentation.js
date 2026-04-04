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
    
    // 碰撞检测器引用（外部注入）
    this.bodyCollision = null;
  }

  async init() {
    if (typeof SelfieSegmentation === 'undefined') {
      console.warn('MediaPipe SelfieSegmentation 未加载，人物遮挡功能不可用');
      return false;
    }

    try {
      this.segmenter = new SelfieSegmentation({
        locateFile: (file) => {
          // 优先使用 CDN 绝对路径（部署后相对路径会 404）
          // 检测是否在 CDN 域名下（部署环境）
          const href = window.location.href;
          if (href.includes('qq.com') || href.includes('gtimg.com')) {
            // 部署环境：使用 CDN 路径
            const cdnBase = 'https://mat1.gtimg.com/qqcdn/redian/petals_fall_test/libs/mediapipe/';
            return cdnBase + file;
          }
          // 本地开发环境：使用相对路径
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
    // canvas 的内部分辨率在 _drawMask 中动态设为视频原始分辨率
    // CSS object-fit: cover 负责显示裁剪
    // 这里不再需要设置 canvas 尺寸
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
    
    // 更新碰撞检测器（传入视频尺寸用于 cover 坐标映射）
    if (this.bodyCollision) {
      const vw = this.video.videoWidth || 0;
      const vh = this.video.videoHeight || 0;
      this.bodyCollision.updateFromMask(results.segmentationMask, vw, vh);
    }
  }

  /**
   * 将人物区域绘制为遮挡层
   * 
   * 关键改进：蒙版和视频都全拉伸到 canvas（不做 JS 层面的 cover 裁剪）
   * canvas 通过 CSS object-fit: cover 实现和 video 标签一致的裁剪对齐
   * 
   * 这样做的好处：
   *   1. 蒙版尺寸（如 256×256）和视频尺寸（如 1280×720）不同也没关系
   *   2. 碰撞检测器也可以直接全拉伸采样蒙版，不需要 crop 参数
   *   3. CSS object-fit: cover 会自动让 canvas 和 video 对齐
   */
  _drawMask(mask) {
    const ctx = this.ctx;
    const vw = this.video.videoWidth || this.canvas.width;
    const vh = this.video.videoHeight || this.canvas.height;

    // canvas 内部分辨率设为视频原始分辨率
    // 这样全拉伸绘制后，CSS object-fit: cover 的裁剪效果和 video 标签完全一致
    if (this.canvas.width !== vw || this.canvas.height !== vh) {
      this.canvas.width = vw;
      this.canvas.height = vh;
    }

    // 彻底清空
    ctx.clearRect(0, 0, vw, vh);

    // 确保 video 有画面
    if (this.video.readyState < 2) return;

    // 第一步：画蒙版（白色=人物，黑色=背景）
    // 全拉伸 — 不做 cover 裁剪
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(mask, 0, 0, vw, vh);

    // 第二步：source-in 模式，用视频帧填充人物区域
    // 视频也全拉伸（视频尺寸 == canvas 尺寸，所以 1:1 映射）
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(this.video, 0, 0, vw, vh);

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
