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

    // === 运动模糊（多帧累积） ===
    // 保存最近 N 帧的花瓣层快照，合成时叠加产生拖影
    this._motionBlurFrames = 3;         // 保留历史帧数
    this._petalHistoryBuffers = [];     // ring buffer: 离屏 canvas 数组
    this._historyWriteIndex = 0;        // 当前写入位置
    this._historyFilled = 0;            // 已填充的帧数
    this._motionBlurInited = false;
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
    const dpr = this.isRecording ? 1 : Math.min(window.devicePixelRatio || 1, 2);
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

    // === 运动模糊：将花瓣层先合成到临时 canvas，再存入历史 buffer ===

    // 懒初始化 / 尺寸变化时重建 buffer
    if (!this._motionBlurInited || this._motionBlurW !== w || this._motionBlurH !== h) {
      this._initMotionBlurBuffers(w, h);
    }

    const tmpCtx = this._petalTempCtx;
    tmpCtx.clearRect(0, 0, w, h);

    // 2. 远景花瓣层（CSS blur(1px) 对应 + 轻微降透）
    if (this.canvasFar.width > 0) {
      tmpCtx.save();
      tmpCtx.globalAlpha = 0.75;
      this._drawBlurred(tmpCtx, this.canvasFar, w, h, 1);
      tmpCtx.restore();
    }

    // 3. 中景花瓣层（无模糊）
    if (this.canvasMid.width > 0) {
      tmpCtx.drawImage(this.canvasMid, 0, 0, w, h);
    }

    // 4. 人物遮罩层 — 录制合成时跳过！
    // canvasPerson 只在屏幕实时显示时用于 CSS z-index 分层（让人物遮挡远景花瓣）。
    // 合成到单个 canvas 时，底层视频已包含完整人物画面，
    // 再叠 canvasPerson 会导致人物区域被 alpha blend 两次 → 残影。

    // 5. 近景花瓣层（CSS blur(4px) 对应 + 降低透明度，更自然的景深虚化）
    if (this.canvasNear.width > 0) {
      tmpCtx.save();
      tmpCtx.globalAlpha = 0.55;
      this._drawBlurred(tmpCtx, this.canvasNear, w, h, 4);
      tmpCtx.restore();
    }

    // --- 运动模糊叠加 ---
    // 先叠历史帧（越老的帧透明度越低），产生运动拖影
    // 透明度分配：从最老到最新 → 0.12, 0.20, 0.30
    const alphaLevels = [0.12, 0.20, 0.30];
    const totalHistory = Math.min(this._historyFilled, this._motionBlurFrames);
    for (let age = totalHistory; age >= 1; age--) {
      // age=1 是上一帧, age=totalHistory 是最老的帧
      const bufIdx = (this._historyWriteIndex - age + this._motionBlurFrames) % this._motionBlurFrames;
      const alphaIdx = this._motionBlurFrames - age; // 0=最老, N-1=最新历史帧
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
    for (let f = 0; f < this._motionBlurFrames; f++) {
      tmpCtx.clearRect(0, 0, w, h);
      if (this.canvasFar.width > 0) {
        tmpCtx.save();
        tmpCtx.globalAlpha = 0.75;
        this._drawBlurred(tmpCtx, this.canvasFar, w, h, 1);
        tmpCtx.restore();
      }
      if (this.canvasMid.width > 0) {
        tmpCtx.drawImage(this.canvasMid, 0, 0, w, h);
      }
      if (this.canvasNear.width > 0) {
        tmpCtx.save();
        tmpCtx.globalAlpha = 0.55;
        this._drawBlurred(tmpCtx, this.canvasNear, w, h, 4);
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
   * 兼容 iOS Safari 的模糊绘制
   * 一次性检测 ctx.filter 是否真正有效，无效时降级为多次缩放模糊
   */
  _drawBlurred(ctx, sourceCanvas, w, h, blurRadius) {
    // 一次性检测 ctx.filter 是否真正生效
    if (this._filterSupported === undefined) {
      this._filterSupported = this._testFilterSupport();
    }

    if (this._filterSupported) {
      ctx.filter = `blur(${blurRadius}px)`;
      ctx.drawImage(sourceCanvas, 0, 0, w, h);
      ctx.filter = 'none';
      return;
    }

    // 降级方案：多轮缩放模糊（效果更接近真实 blur）
    if (!this._blurCanvas) {
      this._blurCanvas = document.createElement('canvas');
      this._blurCtx = this._blurCanvas.getContext('2d');
    }
    if (!this._blurCanvas2) {
      this._blurCanvas2 = document.createElement('canvas');
      this._blurCtx2 = this._blurCanvas2.getContext('2d');
    }

    // 第1轮：大幅缩小
    const s1 = Math.max(0.08, 1 / (1 + blurRadius * 1.5));
    const bw1 = Math.max(2, Math.floor(w * s1));
    const bh1 = Math.max(2, Math.floor(h * s1));
    this._blurCanvas.width = bw1;
    this._blurCanvas.height = bh1;
    this._blurCtx.imageSmoothingEnabled = true;
    this._blurCtx.imageSmoothingQuality = 'high';
    this._blurCtx.drawImage(sourceCanvas, 0, 0, bw1, bh1);

    // 第2轮：放大到中间尺寸（进一步柔化）
    const midW = Math.floor(w * 0.5);
    const midH = Math.floor(h * 0.5);
    this._blurCanvas2.width = midW;
    this._blurCanvas2.height = midH;
    this._blurCtx2.imageSmoothingEnabled = true;
    this._blurCtx2.imageSmoothingQuality = 'high';
    this._blurCtx2.drawImage(this._blurCanvas, 0, 0, bw1, bh1, 0, 0, midW, midH);

    // 第3轮：放大到目标尺寸
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._blurCanvas2, 0, 0, midW, midH, 0, 0, w, h);
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

    try {
      // 预缓存花瓣层历史帧，确保运动模糊有数据
      // 录像中已经有持续的 composite loop 在积累历史帧，无需额外预缓存
      if (!this.isRecording) {
        this._preloadMotionBlurHistory();
      }
      this._composite();
    } catch (err) {
      console.error('合成画面失败:', err);
      this._showToast('拍照失败: 合成出错');
      return;
    }

    // 闪光效果
    if (this.$flash) {
      this.$flash.classList.add('active');
      setTimeout(() => this.$flash.classList.remove('active'), 300);
    }

    const filename = 'petals_' + this._timestamp() + '.png';

    // 导出 blob
    try {
      this.compositeCanvas.toBlob((blob) => {
        if (!blob) {
          this._showToast('拍照失败: 图片生成为空');
          return;
        }

        // 策略1：Web Share API（iOS Safari / Android Chrome 均支持，可直接保存到相册）
        if (navigator.canShare && navigator.share) {
          try {
            const file = new File([blob], filename, { type: 'image/png' });
            if (navigator.canShare({ files: [file] })) {
              navigator.share({
                files: [file],
                title: '花瓣雨',
              }).then(() => {
                this._showToast('已分享/保存');
              }).catch((err) => {
                // 用户取消分享不算错误
                if (err.name !== 'AbortError') {
                  console.warn('分享失败:', err);
                  this._fallbackSavePhoto(blob, filename);
                }
              });
              return;
            }
          } catch (shareErr) {
            console.warn('Web Share API 异常:', shareErr);
          }
        }

        // 策略2：降级方案
        this._fallbackSavePhoto(blob, filename);
      }, 'image/png');
    } catch (err) {
      console.error('toBlob 调用失败:', err);
      this._showToast('拍照失败');
    }
  }

  /**
   * 降级保存方案：弹出图片预览，用户长按保存
   */
  _fallbackSavePhoto(blob, filename) {
    const url = URL.createObjectURL(blob);

    // 尝试 <a> 下载（PC 浏览器有效）
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;

    // 检测是否为移动端（移动端 <a download> 大多不生效）
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

    if (!isMobile) {
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this._showToast('已保存');
      return;
    }

    // 移动端：弹出图片预览弹窗，让用户长按保存
    this._showImagePreview(url);
  }

  /**
   * 图片预览弹窗（移动端长按保存）
   */
  _showImagePreview(imgUrl) {
    let overlay = document.getElementById('photo-preview-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'photo-preview-overlay';
      overlay.className = 'video-preview-overlay';
      overlay.innerHTML = `
        <div class="video-preview-content">
          <div class="video-preview-header">
            <span>长按图片保存到相册</span>
            <button class="video-preview-close" id="photo-preview-close">&times;</button>
          </div>
          <img id="photo-preview-img" style="width:100%;display:block;background:#000;" />
          <p class="video-preview-tip">长按图片 → 保存到手机相册</p>
        </div>
      `;
      document.body.appendChild(overlay);
    }

    const img = document.getElementById('photo-preview-img');
    const closeBtn = document.getElementById('photo-preview-close');

    img.src = imgUrl;
    overlay.classList.add('show');

    const closeHandler = () => {
      overlay.classList.remove('show');
      img.src = '';
      URL.revokeObjectURL(imgUrl);
      closeBtn.removeEventListener('click', closeHandler);
      overlay.removeEventListener('click', overlayClickHandler);
    };
    closeBtn.addEventListener('click', closeHandler);

    const overlayClickHandler = (e) => {
      if (e.target === overlay) closeHandler();
    };
    overlay.addEventListener('click', overlayClickHandler);

    this._showToast('长按图片保存');
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
    const stream = this.compositeCanvas.captureStream(30);

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
        videoBitsPerSecond: 4000000, // 4Mbps
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

      this.mediaRecorder.start(100); // 每 100ms 收集一次数据
      this.isRecording = true;
      this.recordingStartTime = Date.now();

      // 更新 UI
      this.$btnRecord.classList.add('recording');
      this.$recordTime.classList.remove('hidden');
      this._updateRecordingTime();

      // 每帧合成画面给录像流
      this._startCompositeLoop();

      this._showToast('开始录像');
    } catch (err) {
      console.error('录像启动失败:', err);
      this._showToast('录像启动失败');
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.isRecording = false;
    this._resetRecordingUI();
    this._updateCanvasSize(); // 恢复高清分辨率
    this._showToast('正在保存视频...');
  }

  _startCompositeLoop() {
    const loop = () => {
      if (!this.isRecording) return;
      this._composite();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
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

    const blob = new Blob(this.recordedChunks, { type: this.recordedChunks[0].type || 'video/mp4' });
    const url = URL.createObjectURL(blob);

    if (this._isWeChat()) {
      // 微信环境：弹出预览弹窗，让用户长按保存
      this._showVideoPreview(url, blob);
    } else {
      // 非微信：直接下载
      const a = document.createElement('a');
      a.href = url;
      const ext = blob.type.includes('webm') ? 'webm' : 'mp4';
      a.download = 'petals_' + this._timestamp() + '.' + ext;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this._showToast('视频已保存');
    }
  }

  _isWeChat() {
    return /MicroMessenger/i.test(navigator.userAgent);
  }

  _showVideoPreview(url, blob) {
    // 获取或创建预览弹窗
    let overlay = document.getElementById('video-preview-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'video-preview-overlay';
      overlay.className = 'video-preview-overlay';
      overlay.innerHTML = `
        <div class="video-preview-content">
          <div class="video-preview-header">
            <span>视频预览</span>
            <button class="video-preview-close" id="video-preview-close">&times;</button>
          </div>
          <video id="video-preview-player" class="video-preview-player" controls playsinline webkit-playsinline></video>
          <p class="video-preview-tip">长按视频可保存到手机相册</p>
        </div>
      `;
      document.body.appendChild(overlay);
    }

    const player = document.getElementById('video-preview-player');
    const closeBtn = document.getElementById('video-preview-close');

    player.src = url;
    overlay.classList.add('show');

    // 尝试自动播放
    player.play().catch(() => {});

    // 关闭按钮
    const closeHandler = () => {
      overlay.classList.remove('show');
      player.pause();
      player.src = '';
      URL.revokeObjectURL(url);
      closeBtn.removeEventListener('click', closeHandler);
      overlayClickHandler && overlay.removeEventListener('click', overlayClickHandler);
    };
    closeBtn.addEventListener('click', closeHandler);

    // 点击遮罩关闭
    const overlayClickHandler = (e) => {
      if (e.target === overlay) closeHandler();
    };
    overlay.addEventListener('click', overlayClickHandler);

    this._showToast('长按视频可保存');
  }

  _resetRecordingUI() {
    this.$btnRecord.classList.remove('recording');
    this.$recordTime.classList.add('hidden');
    this.$recordTime.textContent = '00:00';
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
