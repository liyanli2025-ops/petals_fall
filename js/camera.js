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

    this.video.onloadedmetadata = () => {
      this.video.play().catch(() => {});
    };
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

    return new Promise((resolve) => {
      this.video.onloadedmetadata = () => {
        this.video.play().then(() => resolve(true)).catch(() => resolve(true));
      };
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

  _showFallback() {
    this.video.classList.add('hidden');
    this.fallbackBg.classList.remove('hidden');
  }

  destroy() {
    this.stopCamera();
  }
}
