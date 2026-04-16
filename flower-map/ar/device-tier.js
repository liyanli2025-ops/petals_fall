/**
 * 设备性能分级检测器
 * 
 * 在页面加载时综合评估设备能力，分为 4 档：
 *   - high:    高端设备，完整体验
 *   - medium:  中端设备，降低材质和花瓣数
 *   - low:     低端设备，关闭人体分割和 CSS blur
 *   - minimal: 极低端/无WebGL，纯 CSS 降级
 * 
 * 评估维度：
 *   1. WebGL 能力 & GPU 型号
 *   2. navigator.deviceMemory
 *   3. navigator.hardwareConcurrency
 *   4. 屏幕分辨率（间接参考）
 *   5. 已知低端 GPU 黑名单
 */
class DeviceTier {
  constructor() {
    this.tier = 'high'; // 默认高端
    this.score = 0;
    this.gpuRenderer = '';
    this.details = {};
    this._detect();
  }

  _detect() {
    let score = 0;
    const details = {};

    // 1. WebGL 可用性
    let canvas, gl;
    try {
      canvas = document.createElement('canvas');
      gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    } catch (e) {
      gl = null;
    }

    if (!gl) {
      this.tier = 'minimal';
      this.score = 0;
      this.details = { reason: 'no-webgl' };
      return;
    }

    details.webgl2 = !!(canvas.getContext('webgl2'));
    score += details.webgl2 ? 15 : 5;

    // 2. GPU 型号
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      this.gpuRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
      details.gpu = this.gpuRenderer;

      const gpu = this.gpuRenderer.toLowerCase();

      // 高端 GPU 加分
      if (/apple gpu|apple m[1-9]|a1[2-9] gpu|a[2-9]\d gpu/i.test(gpu)) {
        score += 30; // Apple A12+ / M1+
      } else if (/adreno 6[3-9]\d|adreno 7\d\d|adreno 8\d\d/i.test(gpu)) {
        score += 25; // Qualcomm 高端
      } else if (/mali-g7[6-9]|mali-g[8-9]\d|mali-g[1-9]\d\d/i.test(gpu)) {
        score += 25; // ARM 高端
      } else if (/nvidia|geforce|rtx|gtx/i.test(gpu)) {
        score += 30; // PC 独显
      } else if (/intel.*iris|intel.*uhd/i.test(gpu)) {
        score += 15; // Intel 核显
      }

      // 低端 GPU 黑名单扣分
      if (/adreno 3\d\d|adreno 4\d\d|adreno 5[0-2]\d/i.test(gpu)) {
        score -= 20; // Qualcomm 低端（Adreno 3xx/4xx/50x-52x）
      } else if (/mali-4\d\d|mali-t[2-6]\d\d|mali-g5[0-1]/i.test(gpu)) {
        score -= 20; // ARM 低端
      } else if (/powervr|vivante|videocore/i.test(gpu)) {
        score -= 15; // 低端嵌入式 GPU
      } else if (/swiftshader|llvmpipe|software/i.test(gpu)) {
        score -= 30; // 软件渲染
      }
    }

    // 3. WebGL 能力参数
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    details.maxTextureSize = maxTextureSize;
    if (maxTextureSize >= 8192) score += 10;
    else if (maxTextureSize >= 4096) score += 5;
    else score -= 5;

    const maxVertexAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
    if (maxVertexAttribs >= 16) score += 5;

    // 4. 设备内存
    const mem = navigator.deviceMemory;
    if (mem !== undefined) {
      details.memory = mem;
      if (mem >= 8) score += 15;
      else if (mem >= 4) score += 10;
      else if (mem >= 2) score += 0;
      else score -= 15; // <2GB 很可能是低端机
    }

    // 5. CPU 核心数
    const cores = navigator.hardwareConcurrency;
    if (cores !== undefined) {
      details.cores = cores;
      if (cores >= 8) score += 10;
      else if (cores >= 4) score += 5;
      else score -= 10; // <4 核
    }

    // 6. 屏幕分辨率（高分辨率通常意味着更好的设备）
    const screenPx = window.screen.width * window.screen.height * (window.devicePixelRatio || 1);
    details.screenPx = screenPx;
    if (screenPx > 3000000) score += 5;  // > 3M 像素
    else if (screenPx < 800000) score -= 5; // < 0.8M 像素

    // 7. iOS 旧设备检测（通过 UA 中的 iOS 版本）
    const iosMatch = navigator.userAgent.match(/OS (\d+)_/i);
    if (iosMatch) {
      const iosVer = parseInt(iosMatch[1]);
      details.iosVersion = iosVer;
      if (iosVer < 15) score -= 15;
      else if (iosVer < 16) score -= 5;
    }

    // 8. Android 旧设备
    const androidMatch = navigator.userAgent.match(/Android (\d+)/i);
    if (androidMatch) {
      const androidVer = parseInt(androidMatch[1]);
      details.androidVersion = androidVer;
      if (androidVer < 10) score -= 15;
      else if (androidVer < 12) score -= 5;
    }

    // 清理临时 canvas
    try {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } catch (e) {}

    // 分级
    this.score = score;
    this.details = details;

    if (score >= 45) {
      this.tier = 'high';
    } else if (score >= 20) {
      this.tier = 'medium';
    } else if (score >= -5) {
      this.tier = 'low';
    } else {
      this.tier = 'minimal';
    }

    console.log('[DeviceTier] 设备评分:', score, '等级:', this.tier, details);
  }

  /**
   * 获取当前等级对应的渲染参数
   */
  getRenderConfig() {
    switch (this.tier) {
      case 'high':
        return {
          petalCount: 3000,
          usePBRMaterial: true,       // MeshPhysicalMaterial
          enableSegmentation: true,   // 人体分割
          segmentationFrameSkip: 1,   // PC 每帧, mobile 会被覆盖
          enableCSSBlur: true,        // CSS filter blur
          cssBlurFar: 1.5,            // 远景 blur px
          cssBlurMid: 1.0,            // 中景 blur px
          cssBlurNear: 4.0,           // 近景 blur px
          dprLimit: 2,                // 像素比上限
          enableAntiAlias: true,
          enableToneMapping: true,
          lightCount: 4,              // 光源数量
        };
      case 'medium':
        return {
          petalCount: 1500,
          usePBRMaterial: false,       // 全部用 BasicMaterial
          enableSegmentation: true,
          segmentationFrameSkip: 4,    // 每 4 帧分割一次
          enableCSSBlur: true,
          cssBlurFar: 1.0,
          cssBlurMid: 0,
          cssBlurNear: 2.0,
          dprLimit: 1.5,
          enableAntiAlias: false,
          enableToneMapping: false,
          lightCount: 2,
        };
      case 'low':
        return {
          petalCount: 800,
          usePBRMaterial: false,
          enableSegmentation: false,   // 关闭人体分割
          segmentationFrameSkip: 0,
          enableCSSBlur: false,        // 关闭 CSS blur
          cssBlurFar: 0,
          cssBlurMid: 0,
          cssBlurNear: 0,
          dprLimit: 1,
          enableAntiAlias: false,
          enableToneMapping: false,
          lightCount: 1,
        };
      case 'minimal':
      default:
        return {
          petalCount: 0,               // 不用 WebGL 花瓣
          usePBRMaterial: false,
          enableSegmentation: false,
          segmentationFrameSkip: 0,
          enableCSSBlur: false,
          cssBlurFar: 0,
          cssBlurMid: 0,
          cssBlurNear: 0,
          dprLimit: 1,
          enableAntiAlias: false,
          enableToneMapping: false,
          lightCount: 0,
          useCSSFallback: true,        // 使用 CSS 动画花瓣兜底
        };
    }
  }
}
