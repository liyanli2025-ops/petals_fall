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
  var landingPoster = document.querySelector('.landing-poster-fallback');

  // 视频播放成功后隐藏兜底图（节省内存）
  var videoPlayStarted = false;
  function onVideoPlaying() {
    if (videoPlayStarted) return;
    videoPlayStarted = true;
    // 视频已在播放，兜底图不再需要
    if (landingPoster) landingPoster.style.display = 'none';
  }

  function tryPlayVideo() {
    if (!landingVideo || !landingVideo.paused) return;
    landingVideo.muted = true;
    var p = landingVideo.play();
    if (p && p.then) {
      p.then(function() { onVideoPlaying(); }).catch(function() {});
    }
  }

  if (landingVideo) {
    // 监听视频播放成功
    landingVideo.addEventListener('playing', onVideoPlaying);
    landingVideo.addEventListener('timeupdate', function onTU() {
      if (landingVideo.currentTime > 0.05) {
        onVideoPlaying();
        landingVideo.removeEventListener('timeupdate', onTU);
      }
    });

    // 1. 立即尝试
    tryPlayVideo();

    // 2. 视频就绪后
    landingVideo.addEventListener('loadedmetadata', tryPlayVideo);
    landingVideo.addEventListener('canplay', tryPlayVideo);

    // 3. 微信专用：WeixinJSBridge + getNetworkType 回调触发（微信官方推荐方案）
    if (isWx) {
      var wxAutoPlay = function() {
        window.WeixinJSBridge.invoke('getNetworkType', {}, function() {
          tryPlayVideo();
        });
      };
      if (window.WeixinJSBridge) {
        wxAutoPlay();
      } else {
        document.addEventListener('WeixinJSBridgeReady', wxAutoPlay, false);
      }
    }

    // 4. 页面加载完
    window.addEventListener('load', tryPlayVideo);

    // 5. 定时重试（前 3 秒每 500ms 试一次）
    var retryCount = 0;
    var retryTimer = setInterval(function() {
      retryCount++;
      tryPlayVideo();
      if (!landingVideo.paused || retryCount >= 6) clearInterval(retryTimer);
    }, 500);

    // 6. 用户触摸兜底（整页任意位置）
    document.addEventListener('touchstart', function videoTouchPlay() {
      tryPlayVideo();
      document.removeEventListener('touchstart', videoTouchPlay);
    }, { once: true, passive: true });

    // 7. 超时检测：5 秒后若视频仍未播放，隐藏 video 让兜底图显示
    setTimeout(function() {
      if (!videoPlayStarted && landingVideo) {
        console.log('[开屏] 视频 5 秒未播放，切换到静态海报兜底');
        landingVideo.style.display = 'none';
        if (landingPoster) landingPoster.style.display = '';
      }
    }, 5000);
  }

  const $landing = document.getElementById('landing');
  const $scene = document.getElementById('scene');
  const $btnStart = document.getElementById('btn-start');
  const $btnSwitchCamera = document.getElementById('btn-switch-camera');
  const $btnToggleCamera = document.getElementById('btn-toggle-camera');
  const $btnWind = document.getElementById('btn-wind');
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

  // === 设备性能分级 ===
  const deviceTier = new DeviceTier();
  const tierConfig = deviceTier.getRenderConfig();

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

      // 带重试的摄像头获取（微信环境不稳定，需要重试）
      async function tryGetCamera(retries) {
        for (let attempt = 0; attempt <= retries; attempt++) {
          if (attempt > 0) {
            debug('摄像头重试 ' + attempt + '/' + retries + '...');
            await new Promise(r => setTimeout(r, 800));
          }
          try {
            // 后置
            return await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
              audio: false
            });
          } catch (err) {
            debug('后置失败(' + attempt + '): ' + err.name);
            try {
              // 前置
              return await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
              });
            } catch (e2) {
              debug('前置失败(' + attempt + '): ' + e2.name);
              try {
                // 无约束降级
                return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
              } catch (e3) {
                debug('降级失败(' + attempt + '): ' + e3.name);
                if (attempt === retries) return null;
              }
            }
          }
        }
        return null;
      }

      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        var maxRetries = isWx ? 2 : 0;
        cameraStream = await tryGetCamera(maxRetries);
        if (cameraStream) {
          debug('摄像头: OK');
        } else {
          debug('摄像头: 所有尝试均失败');
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

      // === 极低端兜底：CSS 花瓣动画 ===
      if (tierConfig.useCSSFallback) {
        debug('设备等级: minimal, 使用 CSS 花瓣兜底');
        _createCSSPetals();
        // 跳过 WebGL 花瓣系统、人体分割等
      } else {
      // 花瓣粒子系统
      particles = new PetalParticleSystem();
      // 传入设备等级配置
      particles.tierConfig = tierConfig;
      particles.init();

      const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
      // 根据设备等级决定花瓣数（移动端在 tierConfig 基础上再乘 0.67）
      let initialCount = tierConfig.petalCount;
      if (isMobile && deviceTier.tier === 'high') {
        initialCount = 2000; // 高端移动端仍保持 2000
      }
      particles.petalCount = initialCount;
      $petalDensity.value = initialCount;
      // 调整密度滑条范围（低端机上限调低）
      if (deviceTier.tier === 'low') {
        $petalDensity.max = 1500;
      } else if (deviceTier.tier === 'medium') {
        $petalDensity.max = 3000;
      }

      // === CSS blur 降级 ===
      if (!tierConfig.enableCSSBlur) {
        // 低端机：移除所有花瓣层的 CSS blur
        var layerFarEl = document.getElementById('canvas-far');
        var layerMidEl = document.getElementById('canvas-mid');
        var layerNearEl = document.getElementById('canvas-near');
        if (layerFarEl) { layerFarEl.style.filter = 'none'; layerFarEl.style.webkitFilter = 'none'; }
        if (layerMidEl) { layerMidEl.style.filter = 'none'; layerMidEl.style.webkitFilter = 'none'; }
        if (layerNearEl) { layerNearEl.style.filter = 'none'; layerNearEl.style.webkitFilter = 'none'; }
      } else if (deviceTier.tier === 'medium') {
        // 中端机：减弱 blur
        var layerFarEl = document.getElementById('canvas-far');
        var layerMidEl = document.getElementById('canvas-mid');
        var layerNearEl = document.getElementById('canvas-near');
        if (layerFarEl) { layerFarEl.style.filter = 'blur(' + tierConfig.cssBlurFar + 'px)'; layerFarEl.style.webkitFilter = 'blur(' + tierConfig.cssBlurFar + 'px)'; }
        if (layerMidEl) { layerMidEl.style.filter = 'blur(' + tierConfig.cssBlurMid + 'px)'; layerMidEl.style.webkitFilter = 'blur(' + tierConfig.cssBlurMid + 'px)'; }
        if (layerNearEl) { layerNearEl.style.filter = 'blur(' + tierConfig.cssBlurNear + 'px)'; layerNearEl.style.webkitFilter = 'blur(' + tierConfig.cssBlurNear + 'px)'; }
      }

      // 人体分割 + 花瓣碰撞
      bodyCollision = new BodyCollisionDetector();
      
      if (cameraStream && tierConfig.enableSegmentation) {
        segmentation = new PersonSegmentation();
        // 按设备等级覆写跳帧
        if (tierConfig.segmentationFrameSkip > 0) {
          segmentation._tierFrameSkip = tierConfig.segmentationFrameSkip;
        }
        const segOk = await segmentation.init();
        if (segOk) {
          // 覆写 frameSkip（如果 tier 指定了）
          if (segmentation._tierFrameSkip && isMobile) {
            segmentation.frameSkip = Math.max(segmentation.frameSkip, segmentation._tierFrameSkip);
          }
          segmentation.bodyCollision = bodyCollision;
          segmentation.start();
          
          // 注入碰撞检测器到花瓣系统
          particles.bodyCollision = bodyCollision;
          
          debug('人体分割+碰撞: 已启动 (跳帧=' + segmentation.frameSkip + ')');
          document.getElementById('canvas-person').style.display = 'block';
        } else {
          debug('人体分割: 不可用，花瓣碰撞关闭');
          segmentation = null;
        }
      } else {
        if (!tierConfig.enableSegmentation) {
          debug('人体分割: 已按设备等级(' + deviceTier.tier + ')关闭');
        }
      }
      } // end of !useCSSFallback

      // minimal 模式下隐藏花瓣密度控制和风起按钮（CSS 花瓣不响应这些）
      if (tierConfig.useCSSFallback) {
        var petalCtrl = document.getElementById('petal-count-control');
        if (petalCtrl) petalCtrl.style.display = 'none';
        $btnWind.parentElement.style.display = 'none';
      }

      // === 4. 切换场景 ===
      $scene.classList.remove('hidden');
      $landing.classList.add('fade-out');
      setTimeout(() => { $landing.classList.add('hidden'); }, 800);

      // === 4.1 显示 AR 引导提示（分步） ===
      (function() {
        var g1 = document.getElementById('ar-guide-1');
        var g2 = document.getElementById('ar-guide-2');
        if (!g1 || !g2) return;
        // 第一个：1s 后显示，持续 3.5s
        setTimeout(function() { g1.classList.add('visible'); }, 1000);
        setTimeout(function() { g1.classList.remove('visible'); g1.classList.add('fade-out'); }, 4500);
        // 第二个：5s 后显示，持续 3.5s
        setTimeout(function() { g2.classList.add('visible'); }, 5000);
        setTimeout(function() { g2.classList.remove('visible'); g2.classList.add('fade-out'); }, 8500);
        // 点击提前关闭当前显示的
        function dismissAll() {
          [g1, g2].forEach(function(g) { g.classList.remove('visible'); g.classList.add('fade-out'); });
        }
        [g1, g2].forEach(function(g) {
          g.addEventListener('click', dismissAll);
          g.addEventListener('touchend', function(e) { e.preventDefault(); dismissAll(); });
        });
      })();

      // === 4.5 初始化拍照/录像 ===
      capture = new CaptureManager();
      capture.cameraManager = cameraModule;
      capture.deviceTier = deviceTier.tier; // 注入设备等级
      if (particles) capture.particleSystem = particles;
      if (segmentation) capture.segmentation = segmentation; // 注入分割引用
      capture.init();
      // 双向绑定：花瓣渲染完成后同步通知录像合成（解决录像黑屏）
      if (particles) particles.captureManager = capture;

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
      }, 2000);

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

      if (gyroscope) gyroscope.update();
      if (particles) particles.update(gyroscope ? gyroscope.getCameraData() : null);

      // 人体分割更新
      if (segmentation) {
        segmentation.update();
      }
    }
    loop();
  }

  // ============================================
  // CSS 花瓣兜底（极低端/无 WebGL 设备）
  // ============================================
  function _createCSSPetals() {
    var container = document.createElement('div');
    container.className = 'css-petals-container';
    var sceneEl = document.getElementById('scene');
    if (!sceneEl) return;
    sceneEl.appendChild(container);

    var count = 30; // CSS 动画花瓣数量（轻量）
    for (var i = 0; i < count; i++) {
      var petal = document.createElement('div');
      petal.className = 'css-petal';
      var size = 12 + Math.random() * 16;
      var left = Math.random() * 100;
      var delay = Math.random() * 8;
      var duration = 6 + Math.random() * 6;
      petal.style.cssText = 'width:' + size + 'px;height:' + size + 'px;'
        + 'left:' + left + '%;'
        + 'animation-duration:' + duration + 's;'
        + 'animation-delay:' + delay + 's;'
        + 'opacity:' + (0.4 + Math.random() * 0.4) + ';';
      container.appendChild(petal);
    }
  }

  // ============================================
  // UI 事件
  // ============================================
  function bindEvents() {
    // === 协议勾选控制按钮状态 ===
    const $agreeCheckbox = document.getElementById('agree-checkbox');
    const $agreementLabel = document.getElementById('landing-agreement');

    function updateBtnState() {
      $btnStart.disabled = !$agreeCheckbox.checked;
      // 同步 pointer-events（iOS 某些版本 disabled 按钮仍可触摸）
      $btnStart.style.pointerEvents = $agreeCheckbox.checked ? 'auto' : 'none';
    }

    if ($agreeCheckbox) {
      $agreeCheckbox.addEventListener('change', updateBtnState);
      // 初始化状态
      updateBtnState();
    }

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
      if (capture) capture.resetMotionBlurHistory();
    });

    // 风起按钮（录像中禁用，避免性能下降）
    const windHandler = (e) => {
      e.preventDefault();
      if (!particles) return;
      if (capture && capture.isRecording) return;
      particles.triggerWindGust();
      // 按钮激活态
      $btnWind.classList.add('wind-active');
      // 风效结束后移除激活态（检查 _userGust.duration）
      const dur = (particles._userGust && particles._userGust.duration) || 4;
      setTimeout(() => { $btnWind.classList.remove('wind-active'); }, dur * 1000);
    };
    $btnWind.addEventListener('click', windHandler);
    $btnWind.addEventListener('touchend', windHandler);

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
      if (el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'LABEL'
        || el.closest('.ui-btn') || el.closest('.petal-control')
        || el.closest('.landing-agreement')
        || el.closest('.agreement-modal')
        || el.closest('.photo-preview-btn') || el.closest('.photo-preview-overlay') || el.closest('.save-preview-close')
        || el.closest('#poster-overlay-wx')) {
        return;
      }
      e.preventDefault();
    }, { passive: false });

    // 三击 FPS + 调试面板 — 完全禁用（生产环境不需要）
    $fpsCounter.style.display = 'none';
    if ($debugPanel) $debugPanel.style.display = 'none';
  }

  function init() {
    bindEvents();

    // === ?auto=1 参数：跳过开屏装饰，只显示一个「进入AR」按钮 ===
    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('auto') === '1') {
      // 隐藏开屏页的所有装饰元素（视频、logo、副标题、描述、协议、提示）
      var landingContent = document.querySelector('.landing-content');
      if (landingContent) {
        // 隐藏除按钮外的所有子元素
        var children = landingContent.children;
        for (var ci = 0; ci < children.length; ci++) {
          if (children[ci] !== $btnStart) {
            children[ci].style.display = 'none';
          }
        }
      }
      // 自动勾选协议
      var cb = document.getElementById('agree-checkbox');
      if (cb) cb.checked = true;
      // 启用按钮，改文字
      $btnStart.disabled = false;
      $btnStart.style.pointerEvents = 'auto';
      $btnStart.style.cssText = 'pointer-events:auto;padding:18px 56px;font-size:1.2rem;';
      $btnStart.innerHTML = '<span>点击开启 AR 花瓣雨</span>';
      return;
    }

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
