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

  const $landing = document.getElementById('landing');
  const $landingPetals = document.getElementById('landing-petals');
  const $scene = document.getElementById('scene');
  const $btnStart = document.getElementById('btn-start');
  const $btnSwitchCamera = document.getElementById('btn-switch-camera');
  const $btnToggleCamera = document.getElementById('btn-toggle-camera');
  const $petalDensity = document.getElementById('petal-density');
  const $fpsCounter = document.getElementById('fps-counter');
  const $debug = document.getElementById('debug-info');

  let cameraModule = null;
  let gyroscope = null;
  let particles = null;
  let segmentation = null;
  let capture = null;
  let animationId = null;
  let performanceTuneTimer = null;

  function debug(msg) {
    console.log(msg);
    if ($debug) $debug.textContent += msg + '\n';
  }

  // ============================================
  // Landing 花瓣装饰
  // ============================================
  function createLandingPetals() {
    const count = window.innerWidth > 768 ? 25 : 15;
    for (let i = 0; i < count; i++) {
      const petal = document.createElement('div');
      petal.className = 'landing-petal';
      petal.style.left = Math.random() * 100 + '%';
      petal.style.animationDuration = 4 + Math.random() * 6 + 's';
      petal.style.animationDelay = Math.random() * 8 + 's';
      petal.style.transform = `scale(${0.5 + Math.random() * 1.0})`;
      $landingPetals.appendChild(petal);
    }
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
          debug('后置摄像头失败: ' + err.name);
          // 再试前置
          try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
              audio: false
            });
            debug('摄像头: 前置OK');
          } catch (e2) {
            debug('前置摄像头也失败: ' + e2.name);
          }
        }
      } else {
        debug('getUserMedia 不可用（可能非HTTPS）');
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
      const initialCount = isMobile ? 1000 : 1200;
      particles.petalCount = initialCount;
      $petalDensity.value = initialCount;

      // 人体分割 — 默认关闭
      // 该功能会将摄像头中的人物剪影复制到独立 canvas 层，
      // 遮挡背后的花瓣。但在当前实现中，效果更像"浮动人脸贴纸"，
      // 体验不佳，暂时禁用。如需启用可取消下方注释。
      // if (cameraStream) {
      //   segmentation = new PersonSegmentation();
      //   const segOk = await segmentation.init();
      //   if (segOk) {
      //     segmentation.start();
      //     debug('人体分割: 已启动');
      //   } else {
      //     debug('人体分割: 不可用');
      //     segmentation = null;
      //   }
      // }
      segmentation = null;

      // === 4. 切换场景 ===
      $scene.classList.remove('hidden');
      $landing.classList.add('fade-out');
      setTimeout(() => { $landing.classList.add('hidden'); }, 800);

      // === 4.5 初始化拍照/录像 ===
      capture = new CaptureManager();
      capture.init();

      if (!cameraModule.hasCamera) {
        $btnSwitchCamera.classList.add('hidden');
        $btnToggleCamera.classList.add('hidden');
      } else {
        // 有摄像头就显示切换和开关按钮
        $btnSwitchCamera.classList.remove('hidden');
        $btnToggleCamera.classList.remove('hidden');
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
    function loop() {
      animationId = requestAnimationFrame(loop);

      gyroscope.update();
      particles.update(gyroscope.getCameraData());

      // 人体分割更新
      if (segmentation) {
        segmentation.update();
      }

      if (particles.fps > 0) {
        $fpsCounter.textContent = `FPS: ${particles.fps} | 花瓣: ${particles.petalCount}`;
      }
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
      if (cameraModule) cameraModule.switchCamera();
    });
    $btnSwitchCamera.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (cameraModule) cameraModule.switchCamera();
    });

    $btnToggleCamera.addEventListener('click', () => {
      if (cameraModule) cameraModule.toggleCamera();
    });
    $btnToggleCamera.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (cameraModule) cameraModule.toggleCamera();
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
      if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
      }
    }, { passive: false });

    // 三击 FPS
    $fpsCounter.style.display = 'none';
    let tapCount = 0;
    let tapTimer = null;
    document.addEventListener('click', () => {
      tapCount++;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        if (tapCount >= 3) {
          $fpsCounter.style.display = $fpsCounter.style.display === 'none' ? 'block' : 'none';
        }
        tapCount = 0;
      }, 500);
    });
  }

  function init() {
    createLandingPetals();
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
