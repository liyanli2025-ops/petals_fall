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
  }

  init() {
    this.$btnPhoto = document.getElementById('btn-photo');
    this.$btnRecord = document.getElementById('btn-record');
    this.$recordTime = document.getElementById('record-time');
    this.$flash = document.getElementById('capture-flash');
    this.$toast = document.getElementById('capture-toast');

    this.$btnPhoto.addEventListener('click', () => this.takePhoto());
    this.$btnRecord.addEventListener('click', () => this.toggleRecording());

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.compositeCanvas.width = window.innerWidth * dpr;
    this.compositeCanvas.height = window.innerHeight * dpr;
  }

  /**
   * 将所有可见层合成到离屏 canvas
   */
  _composite() {
    const ctx = this.compositeCtx;
    const w = this.compositeCanvas.width;
    const h = this.compositeCanvas.height;

    ctx.clearRect(0, 0, w, h);

    // 1. 摄像头视频 / 降级背景
    if (this.video && !this.video.classList.contains('hidden') && this.video.readyState >= 2) {
      // 保持 object-fit: cover 的效果
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (vw && vh) {
        const scale = Math.max(w / vw, h / vh);
        const sw = vw * scale;
        const sh = vh * scale;
        const sx = (w - sw) / 2;
        const sy = (h - sh) / 2;
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

    // 2. 远景花瓣层
    if (this.canvasFar.width > 0) {
      ctx.filter = 'blur(2px)';
      ctx.drawImage(this.canvasFar, 0, 0, w, h);
      ctx.filter = 'none';
    }

    // 3. 中景花瓣层
    if (this.canvasMid.width > 0) {
      ctx.drawImage(this.canvasMid, 0, 0, w, h);
    }

    // 4. 人物遮罩层
    if (this.canvasPerson && this.canvasPerson.style.display !== 'none') {
      ctx.drawImage(this.canvasPerson, 0, 0, w, h);
    }

    // 5. 近景花瓣层
    if (this.canvasNear.width > 0) {
      ctx.filter = 'blur(6px)';
      ctx.drawImage(this.canvasNear, 0, 0, w, h);
      ctx.filter = 'none';
    }
  }

  // ============================================
  // 拍照
  // ============================================
  takePhoto() {
    this._composite();

    // 闪光效果
    if (this.$flash) {
      this.$flash.classList.add('active');
      setTimeout(() => this.$flash.classList.remove('active'), 300);
    }

    const filename = 'petals_' + this._timestamp() + '.png';

    // 导出 blob
    this.compositeCanvas.toBlob((blob) => {
      if (!blob) {
        this._showToast('拍照失败');
        return;
      }

      // 策略1：Web Share API（iOS Safari / Android Chrome 均支持，可直接保存到相册）
      if (navigator.canShare && navigator.share) {
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
              this._fallbackSavePhoto(blob, filename);
            }
          });
          return;
        }
      }

      // 策略2：降级方案
      this._fallbackSavePhoto(blob, filename);
    }, 'image/png');
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
    // 从合成 canvas 获取媒体流
    const stream = this.compositeCanvas.captureStream(30);

    // 尝试添加音频（如果摄像头有音频轨道）
    // 本项目 audio: false，所以一般没有音频

    // 选择编码格式
    const mimeTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
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

    const blob = new Blob(this.recordedChunks, { type: this.recordedChunks[0].type || 'video/webm' });
    const url = URL.createObjectURL(blob);

    if (this._isWeChat()) {
      // 微信环境：弹出预览弹窗，让用户长按保存
      this._showVideoPreview(url, blob);
    } else {
      // 非微信：直接下载
      const a = document.createElement('a');
      a.href = url;
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
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
