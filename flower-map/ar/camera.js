/**
 * 摄像头模块
 * 支持两种初始化方式：
 *   1. initWithStream(stream) — 外部已获取的媒体流（推荐，iOS Safari 兼容）
 *   2. init() — 自行请求权限（传统方式）
 */
class CameraManager {
  constructor() {
    this.video = document.getElementById('camera-video');
    this.fallbackBg = document.getElementById('fallback-bg');
    this.stream = null;
    this.facingMode = 'environment';
    this.isActive = false;
    this.hasCamera = false;
  }

  /**
   * 用已有的媒体流初始化（推荐）
   * 由 app.js 在用户手势内获取 stream 后传入
   */
  initWithStream(stream) {
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.classList.remove('hidden');
    this.fallbackBg.classList.add('hidden');
    this.isActive = true;
    this.hasCamera = true;

    // 检测是前置还是后置
    const track = stream.getVideoTracks()[0];
    if (track) {
      const settings = track.getSettings();
      this.facingMode = settings.facingMode || 'environment';
    }

    // 前置摄像头做镜像翻转
    this._updateMirror();

    // 微信内置浏览器中 video.play() 经常静默失败或 loadedmetadata 事件错过
    // 多时机多次尝试 play，确保视频不会卡在黑屏
    const tryPlay = () => {
      if (this.video.paused && this.video.srcObject) {
        this.video.play().catch(() => {});
      }
    };

    // 1. 立即尝试
    tryPlay();

    // 2. loadedmetadata 时
    this.video.onloadedmetadata = tryPlay;

    // 3. canplay 时
    this.video.addEventListener('canplay', tryPlay, { once: true });

    // 4. 延迟重试（微信有时候需要等一会儿 stream 才稳定）
    setTimeout(tryPlay, 300);
    setTimeout(tryPlay, 800);
    setTimeout(tryPlay, 1500);
  }

  /**
   * 传统初始化（非 iOS 场景备用）
   */
  async init() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('浏览器不支持 getUserMedia');
      this._showFallback();
      return false;
    }

    try {
      await this.startCamera();
      this.hasCamera = true;
      return true;
    } catch (err) {
      console.warn('摄像头初始化失败:', err.name, err.message);

      if (err.name === 'OverconstrainedError') {
        try {
          this.facingMode = 'user';
          await this.startCamera();
          this.hasCamera = true;
          return true;
        } catch (e2) {
          console.warn('前置摄像头也无法使用:', e2);
        }
      }

      this._showFallback();
      return false;
    }
  }

  async startCamera() {
    this.stopCamera();

    const constraints = {
      video: {
        facingMode: this.facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    this.video.classList.remove('hidden');
    this.fallbackBg.classList.add('hidden');
    this.isActive = true;

    // 前置摄像头做镜像翻转（像照镜子）
    this._updateMirror();

    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) { resolved = true; resolve(true); }
      };

      const tryPlay = () => {
        if (this.video.paused && this.video.srcObject) {
          this.video.play().then(done).catch(done);
        } else {
          done();
        }
      };

      // 多时机尝试
      tryPlay();
      this.video.onloadedmetadata = tryPlay;
      this.video.addEventListener('canplay', tryPlay, { once: true });
      // 超时保底（防止微信中事件不触发导致永远卡住）
      setTimeout(tryPlay, 500);
      setTimeout(done, 2000);
    });
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    this.isActive = false;
  }

  async switchCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    try {
      await this.startCamera();
      this.hasCamera = true;
    } catch (err) {
      console.warn('切换摄像头失败:', err);
      this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
      try {
        await this.startCamera();
      } catch (e2) {
        this._showFallback();
      }
    }
  }

  async toggleCamera() {
    if (this.isActive) {
      this.stopCamera();
      this.video.classList.add('hidden');
      this._showFallback();
    } else {
      try {
        await this.startCamera();
      } catch (err) {
        console.warn('无法重新开启摄像头:', err);
        this._showFallback();
      }
    }
  }

  _updateMirror() {
    const canvasPerson = document.getElementById('canvas-person');
    if (this.facingMode === 'user') {
      this.video.style.transform = 'scaleX(-1)';
      if (canvasPerson) canvasPerson.style.transform = 'scaleX(-1)';
    } else {
      this.video.style.transform = '';
      if (canvasPerson) canvasPerson.style.transform = '';
    }
  }

  _showFallback() {
    this.video.classList.add('hidden');
    this.fallbackBg.classList.remove('hidden');
  }

  destroy() {
    this.stopCamera();
  }
}
