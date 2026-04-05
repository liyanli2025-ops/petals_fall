/**
 * 花瓣雨 AR 全息 - 主控制器 v3
 * 
 * iOS Safari 权限修复策略：
 *   1. 按钮绑定 touchend 事件（iOS 更可靠）
 *   2. 在事件回调中直接（非 async）调用 requestPermission
 *   3. 摄像头和陀螺仪权限串行请求，每个都在用户交互上下文中
 */
(function () {
  'use strict';

  // === 视频自动播放兼容（所有环境） ===
  var isWx = /MicroMessenger/i.test(navigator.userAgent);
  var landingVideo = document.querySelector('.landing-video');

  function tryPlayVideo() {
    if (!landingVideo || !landingVideo.paused) return;
    // 确保静音（部分浏览器只允许静音自动播放）
    landingVideo.muted = true;
    var p = landingVideo.play();
    if (p && p.catch) p.catch(function() {});
  }

  if (landingVideo) {
    // 1. 立即尝试
    tryPlayVideo();

    // 2. 视频元数据加载后再试
    landingVideo.addEventListener('loadedmetadata', tryPlayVideo);
    landingVideo.addEventListener('canplay', tryPlayVideo);

    // 3. 微信 WeixinJSBridge 就绪后触发
    if (isWx) {
      if (window.WeixinJSBridge) {
        tryPlayVideo();
      } else {
        document.addEventListener('WeixinJSBridgeReady', tryPlayVideo, false);
      }
    }

    // 4. DOMContentLoaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryPlayVideo);
    } else {
      tryPlayVideo();
    }

    // 5. 页面完全加载后
    window.addEventListener('load', tryPlayVideo);

    // 6. 用户首次触摸兜底
    document.addEventListener('touchstart', function videoTouchPlay() {
      tryPlayVideo();
      document.removeEventListener('touchstart', videoTouchPlay);
    }, { once: true, passive: true });
  }

  const $landing = document.getElementById('landing');
  const $scene = document.getElementById('scene');
  const $btnStart = document.getElementById('btn-start');
  const $btnSwitchCamera = document.getElementById('btn-switch-camera');
  const $btnToggleCamera = document.getElementById('btn-toggle-camera');
  const $petalDensity = document.getElementById('petal-density');
  const $fpsCounter = document.getElementById('fps-counter');
  const $debugPanel = document.getElementById('debug-panel');
  const $debug = document.getElementById('debug-info');

  let cameraModule = null;
  let gyroscope = null;
  let particles = null;
  let segmentation = null;
  let bodyCollision = null;
  let capture = null;
  let animationId = null;
  let performanceTuneTimer = null;

  function debug(msg) {
    console.log(msg);
  }

  // ============================================
  // 启动体验 — iOS Safari 兼容版
  // 
  // 关键：iOS Safari 要求 requestPermission() 在
  // 「用户激活」(user activation) 窗口内调用。
  // 一个 user activation 窗口只有几秒有效期，
  // 但 async/await 不会消耗这个窗口（只要不超时）。
  // 
  // 真正的问题可能是：页面不是 HTTPS！
  // getUserMedia 和 DeviceOrientation 在非 HTTPS 
  // 下完全不可用（iOS Safari 更严格）。
  // ============================================
  async function startExperience() {
    $btnStart.disabled = true;
    $btnStart.innerHTML = '<span>正在请求权限...</span>';
    if ($debug) $debug.textContent = '';

    try {
      // === 1. 陀螺仪权限 ===
      let gyroGranted = false;
      debug('检查陀螺仪...');

      if (window.DeviceOrientationEvent) {
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
          debug('iOS: 请求陀螺仪权限...');
          try {
            const perm = await DeviceOrientationEvent.requestPermission();
            gyroGranted = (perm === 'granted');
            debug('陀螺仪权限: ' + perm);
          } catch (err) {
            debug('陀螺仪权限错误: ' + err.message);
          }
        } else {
          debug('非iOS设备，无需请求陀螺仪权限');
          gyroGranted = true;
        }
      } else {
        debug('DeviceOrientationEvent 不可用');
      }

      // === 2. 摄像头权限 ===
      let cameraStream = null;
      debug('请求摄像头...');

      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        // 先尝试后置
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
          });
          debug('摄像头: 后置OK');
        } catch (err) {
          debug('后置摄像头失败: ' + err.name + ' ' + err.message);
          // 再试前置
          try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
              audio: false
            });
            debug('摄像头: 前置OK');
          } catch (e2) {
            debug('前置摄像头也失败: ' + e2.name + ' ' + e2.message);
            // 最后降级：不指定任何约束
            try {
              cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
              debug('摄像头: 降级模式OK');
            } catch (e3) {
              debug('所有摄像头尝试均失败: ' + e3.name);
            }
          }
        }
      } else {
        debug('getUserMedia 不可用');
        // 微信环境下 getUserMedia 可能不在 navigator.mediaDevices 上
        if (isWx) {
          debug('微信环境，尝试旧版 API...');
          var getUserMediaLegacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
          if (getUserMediaLegacy) {
            try {
              cameraStream = await new Promise(function(resolve, reject) {
                getUserMediaLegacy.call(navigator, { video: true, audio: false }, resolve, reject);
              });
              debug('摄像头: 旧版API OK');
            } catch(e4) {
              debug('旧版API也失败: ' + e4.name);
            }
          }
        }
      }

      $btnStart.innerHTML = '<span>正在加载...</span>';

      // === 3. 初始化模块 ===
      // 摄像头
      cameraModule = new CameraManager();
      if (cameraStream) {
        cameraModule.initWithStream(cameraStream);
      } else {
        cameraModule._showFallback();
      }

      // 陀螺仪/鼠标
      gyroscope = new GyroscopeManager();
      await gyroscope.initWithPermission(gyroGranted);
      debug('控制模式: ' + gyroscope.mode);

      // 花瓣粒子系统
      particles = new PetalParticleSystem();
      particles.init();

      const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
      const initialCount = isMobile ? 2000 : 3000;
      particles.petalCount = initialCount;
      $petalDensity.value = initialCount;

      // 人体分割 + 花瓣碰撞
      bodyCollision = new BodyCollisionDetector();
      
      if (cameraStream) {
        segmentation = new PersonSegmentation();
        const segOk = await segmentation.init();
        if (segOk) {
          segmentation.bodyCollision = bodyCollision;
          segmentation.start();
          
          // 注入碰撞检测器到花瓣系统
          particles.bodyCollision = bodyCollision;
          
          debug('人体分割+碰撞: 已启动');
          document.getElementById('canvas-person').style.display = 'block';
        } else {
          debug('人体分割: 不可用，花瓣碰撞关闭');
          segmentation = null;
        }
      }

      // === 4. 切换场景 ===
      $scene.classList.remove('hidden');
      $landing.classList.add('fade-out');
      setTimeout(() => { $landing.classList.add('hidden'); }, 800);

      // === 4.5 初始化拍照/录像 ===
      capture = new CaptureManager();
      capture.cameraManager = cameraModule;
      capture.particleSystem = particles;
      capture.init();

      // 暴露 gyroscope 到全局，供拍照时获取相机数据
      window._gyroscope = gyroscope;

      if (!cameraModule.hasCamera) {
        $btnSwitchCamera.classList.add('hidden');
      } else {
        $btnSwitchCamera.classList.remove('hidden');
      }

      // === 5. 启动动画 ===
      startAnimationLoop();

      performanceTuneTimer = setInterval(() => {
        if (particles) particles.autoTunePerformance();
      }, 5000);

    } catch (err) {
      debug('启动失败: ' + err.message);
      console.error('启动失败:', err);
      $btnStart.disabled = false;
      $btnStart.innerHTML = '<span class="btn-icon">⚠️</span><span>重试</span>';
    }
  }

  // ============================================
  // 动画循环
  // ============================================
  function startAnimationLoop() {
    let lastTime = performance.now();
    
    function loop() {
      animationId = requestAnimationFrame(loop);
      
      const now = performance.now();
      const delta = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      gyroscope.update();
      particles.update(gyroscope.getCameraData());

      // 人体分割更新
      if (segmentation) {
        segmentation.update();
      }

      if (particles.fps > 0 && $fpsCounter.style.display !== 'none') {
        $fpsCounter.textContent = `FPS:${particles.fps}`;
      }

      // 调试面板已关闭
    }
    loop();
  }

  // ============================================
  // UI 事件
  // ============================================
  function bindEvents() {
    // 关键：同时绑定 click 和 touchend
    // iOS Safari 上 touchend 比 click 更可靠地传递 user activation
    const startHandler = (e) => {
      e.preventDefault();
      // 防止重复触发
      if ($btnStart.disabled) return;
      startExperience();
    };

    $btnStart.addEventListener('click', startHandler);
    $btnStart.addEventListener('touchend', startHandler);

    $btnSwitchCamera.addEventListener('click', () => {
      if (capture && capture.isRecording) return; // 录像中禁用
      if (cameraModule) cameraModule.switchCamera();
    });
    $btnSwitchCamera.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (capture && capture.isRecording) return; // 录像中禁用
      if (cameraModule) cameraModule.switchCamera();
    });

    $petalDensity.addEventListener('input', (e) => {
      const count = parseInt(e.target.value);
      if (particles) particles.setPetalCount(count);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (animationId) {
          cancelAnimationFrame(animationId);
          animationId = null;
        }
      } else {
        if (!animationId && particles) {
          particles.clock.getDelta();
          startAnimationLoop();
        }
      }
    });

    document.addEventListener('touchstart', (e) => {
      // 不阻止 UI 按钮及其子元素（SVG/path 等）的触摸
      const el = e.target;
      if (el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.closest('.ui-btn') || el.closest('.petal-control')) {
        return;
      }
      e.preventDefault();
    }, { passive: false });

    // 三击 FPS + 调试面板
    $fpsCounter.style.display = 'none';
    if ($debugPanel) $debugPanel.style.display = 'none';
    let tapCount = 0;
    let tapTimer = null;
    let usedTouch = false;
    const handleTripleTap = () => {
      tapCount++;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        if (tapCount >= 3) {
          const show = $fpsCounter.style.display === 'none' ? 'block' : 'none';
          $fpsCounter.style.display = show;
          if ($debugPanel) $debugPanel.style.display = show;
        }
        tapCount = 0;
      }, 500);
    };
    // 手机上 touchstart 的 preventDefault 会阻止 click，用 touchend 代替
    document.addEventListener('touchend', () => {
      usedTouch = true;
      handleTripleTap();
    });
    // 桌面端用 click，避免与 touch 重复计数
    document.addEventListener('click', () => {
      if (!usedTouch) handleTripleTap();
      usedTouch = false;
    });
  }

  function init() {
    bindEvents();

    // 显示协议提示（帮助用户理解为什么权限不弹）
    const proto = window.location.protocol;
    if (proto !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      if ($debug) {
        $debug.textContent = '⚠️ 当前非HTTPS，摄像头/陀螺仪可能不可用。请部署到HTTPS服务器。';
        $debug.style.opacity = '0.7';
        $debug.style.color = '#c62828';
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
