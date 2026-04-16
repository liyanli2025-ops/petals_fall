/* ============================================
   五一花开地图 H5 — 交互逻辑 v5（无花瓣 + iframe渐变版）
   ============================================ */

(function() {
  'use strict';

  // ==========================================
  // 配置
  // ==========================================
  var CITIES = [
    { id: 'harbin',     name: '哈尔滨', flower: '丁香花',  colors: ['#c9a0dc', '#a87cc4', '#d4b8e8', '#b090d0'], petalImg: 'img/petal-lilac.png' },
    { id: 'beijing',    name: '北京',   flower: '芍药花',  colors: ['#f0b8c8', '#e8a0b8', '#f5c8d8', '#e090a8'], petalImg: 'img/petal-shaoyao.png' },
    { id: 'luoyang',    name: '洛阳',   flower: '牡丹花',  colors: ['#f2a0b0', '#e87890', '#f5c0cc', '#e06080'], petalImg: 'img/petal-peony.png' },
    { id: 'wuhan',      name: '武汉',   flower: '蔷薇花',  colors: ['#f5b8c8', '#f0a0b4', '#f8c8d8', '#e890a4'], petalImg: 'img/petal-rosa.png' },
    { id: 'changsha',   name: '长沙',   flower: '杜鹃花',  colors: ['#f06888', '#e04868', '#f08898', '#d03858'], petalImg: 'img/petal-azalea.png' },
    { id: 'wuyuan',     name: '婺源',   flower: '紫藤花',  colors: ['#b090d0', '#9878c0', '#c8a8e0', '#8868b0'], petalImg: 'img/petal-wisteria.png' },
    { id: 'guangzhou',  name: '广州',   flower: '凤凰木',  colors: ['#f06030', '#e04820', '#f58050', '#d03818'], petalImg: 'img/petal-delonix.png' },
    { id: 'sanya',      name: '三亚',   flower: '三角梅',  colors: ['#f040a0', '#d83088', '#f060b0', '#c02878'], petalImg: 'img/petal-bougainvillea.png' }
  ];

  // ==========================================
  // 状态
  // ==========================================
  var state = {
    introVisible: true,
    bloomedCities: {},
    particleCanvas: null,
    particleCtx: null,
    particleLayers: [[], [], []], // [远景, 中景, 近景]
    cityNodes: [],
    progressDots: [],
    routeDrawn: false,
    petalImages: {}
  };

  // ==========================================
  // 预加载花瓣图片（城市绽放用）
  // ==========================================
  function preloadPetalImages() {
    CITIES.forEach(function(city) {
      var img = new Image();
      img.src = city.petalImg;
      state.petalImages[city.id] = img;
    });
  }

  // ==========================================
  // 初始化
  // ==========================================
  function init() {
    preloadPetalImages();
    setupCanvas();
    cacheElements();
    buildRoute();
    createProgressDots();
    setupIntersectionObserver();
    setupEventListeners();
    setupIntroScroll();
    startParticleLoop();
    addDecoFlowers();
  }

  // ==========================================
  // 开屏滑动消失
  // ==========================================
  function setupIntroScroll() {
    var intro = document.getElementById('intro');
    if (!intro) return;

    var dismissed = false;

    // 按钮点击进入
    var btnEnter = document.getElementById('btn-enter');
    if (btnEnter) {
      btnEnter.addEventListener('click', function() {
        if (!dismissed) { dismissed = true; dismissIntro(); }
      });
    }

    var startY = 0;
    intro.addEventListener('touchstart', function(e) {
      startY = e.touches[0].clientY;
    }, { passive: true });

    intro.addEventListener('touchmove', function(e) {
      if (dismissed) return;
      if (startY - e.touches[0].clientY > 50) {
        dismissed = true;
        dismissIntro();
      }
    }, { passive: true });

    intro.addEventListener('wheel', function(e) {
      if (dismissed) return;
      if (e.deltaY > 20) {
        dismissed = true;
        dismissIntro();
      }
    }, { passive: true });
  }

  function dismissIntro() {
    var intro = document.getElementById('intro');
    if (!intro) return;

    // 先锁定滚动位置到顶部
    document.body.style.overflow = 'hidden';
    window.scrollTo(0, 0);

    intro.classList.add('fade-out');
    state.introVisible = false;

    // 暂停视频节省资源
    var video = intro.querySelector('.intro-video');
    if (video) { video.pause(); video.src = ''; }

    var pb = document.getElementById('progress-bar');
    if (pb) pb.classList.add('visible');
    var mc = document.querySelector('.map-container');
    if (mc) mc.classList.add('scrolling');

    setTimeout(animateRoute, 600);

    // 开屏消失后主动触发哈尔滨（第一个城市）绽放
    setTimeout(function() {
      if (state.cityNodes[0]) {
        triggerBloom(state.cityNodes[0], 0);
      }
    }, 1000);

    setTimeout(function() {
      intro.style.display = 'none';
      // 确保在顶部，然后解锁滚动
      window.scrollTo(0, 0);
      document.body.style.overflow = '';
    }, 900);
  }

  // ==========================================
  // 路线动态生成 & 绘制动画
  // ==========================================
  function buildRoute() {
    var nodes = state.cityNodes;
    if (nodes.length < 2) return;

    var points = [];
    var containerW = 375;

    var cityTops = [50, 600, 1050, 1500, 1950, 2400, 2850, 3300];
    var cityXs = [
      containerW * 0.30,
      containerW * 0.65,
      containerW * 0.35,
      containerW * 0.68,
      containerW * 0.28,
      containerW * 0.70,
      containerW * 0.32,
      containerW * 0.66
    ];

    for (var i = 0; i < cityTops.length; i++) {
      points.push({ x: cityXs[i], y: cityTops[i] + 40 });
    }

    // 用 catmull-rom → cubic bezier 保证路径经过所有点
    var d = 'M ' + points[0].x + ' ' + (points[0].y - 60);
    // 起点到第一个城市
    d += ' C ' + points[0].x + ' ' + (points[0].y - 30) + ', ' +
      ((points[0].x + points[1].x) / 2) + ' ' + ((points[0].y + points[1].y) / 2 - 40) + ', ' +
      points[0].x + ' ' + points[0].y;

    for (var j = 0; j < points.length - 1; j++) {
      var p0 = points[Math.max(0, j - 1)];
      var p1 = points[j];
      var p2 = points[j + 1];
      var p3 = points[Math.min(points.length - 1, j + 2)];
      // catmull-rom 转 cubic bezier 控制点
      var tension = 0.35;
      var cpx1 = p1.x + (p2.x - p0.x) * tension;
      var cpy1 = p1.y + (p2.y - p0.y) * tension;
      var cpx2 = p2.x - (p3.x - p1.x) * tension;
      var cpy2 = p2.y - (p3.y - p1.y) * tension;
      d += ' C ' + cpx1 + ' ' + cpy1 + ', ' + cpx2 + ' ' + cpy2 + ', ' + p2.x + ' ' + p2.y;
    }
    // 延伸到最后一个城市下方
    var lastPt = points[points.length - 1];
    d += ' L ' + lastPt.x + ' ' + (lastPt.y + 60);

    var path = document.getElementById('main-route');
    if (path) {
      path.setAttribute('d', d);
    }
  }

  function animateRoute() {
    if (state.routeDrawn) return;
    state.routeDrawn = true;

    var path = document.getElementById('main-route');
    var trailContainer = document.getElementById('petal-trail');
    if (!path || !trailContainer) return;

    var length = path.getTotalLength();
    if (length < 10) return;

    // 每个城市区段对应的花瓣图片
    var segmentPetals = [
      'img/petal-lilac.png',        // 哈尔滨 丁香花
      'img/petal-shaoyao.png',      // 北京 芍药花
      'img/petal-peony.png',        // 洛阳 牡丹花
      'img/petal-rosa.png',         // 武汉 蔷薇花
      'img/petal-azalea.png',       // 长沙 杜鹃花
      'img/petal-wisteria.png',     // 婺源 紫藤花
      'img/petal-delonix.png',      // 广州 凤凰木
      'img/petal-bougainvillea.png' // 三亚 三角梅
    ];

    // 用 map-container 实际宽度计算缩放（不依赖 SVG 的 DOM 尺寸）
    var mapContainer = document.getElementById('map-container');
    var containerWidth = mapContainer ? mapContainer.offsetWidth : window.innerWidth;
    // SVG viewBox 是 375 宽，container 实际宽度按比例缩放
    var scaleX = containerWidth / 375;
    // viewBox 高 4800，但 map-container min-height 是 3900px
    // SVG preserveAspectRatio="xMidYMin meet"，所以 SVG 实际渲染高度 = containerWidth / 375 * 4800
    var svgRenderHeight = containerWidth / 375 * 4800;
    var scaleY = svgRenderHeight / 4800; // 等于 scaleX

    // 沿路径采样点 — 更密集、更显眼
    var totalPetals = 90;
    var petals = [];
    for (var i = 0; i < totalPetals; i++) {
      var t = i / (totalPetals - 1);
      // 加一点随机偏移，不要太整齐
      var tJitter = t + (Math.random() - 0.5) * 0.008;
      tJitter = Math.max(0, Math.min(1, tJitter));
      var dist = tJitter * length;
      var pt = path.getPointAtLength(dist);

      // 确定这个点属于哪个城市区段（8段均分）
      var segIdx = Math.min(7, Math.floor(t * 8));

      // 位置随机偏移（散落在路径两侧）
      var offsetX = (Math.random() - 0.5) * 24;
      var offsetY = (Math.random() - 0.5) * 12;

      var size = 14 + Math.random() * 14; // 14~28px
      var rotation = Math.random() * 360;
      var opacity = 0.55 + Math.random() * 0.3; // 0.55~0.85

      petals.push({
        x: pt.x * scaleX + offsetX,
        y: pt.y * scaleY + offsetY,
        size: size,
        rotation: rotation,
        opacity: opacity,
        petalImg: segmentPetals[segIdx],
        delay: t * 2.5 // 2.5秒总动画时长，从北到南依次出现
      });
    }

    // 创建花瓣 DOM 元素
    var fragment = document.createDocumentFragment();
    petals.forEach(function(p) {
      var el = document.createElement('div');
      el.className = 'trail-petal';
      el.style.cssText =
        'left:' + p.x + 'px;' +
        'top:' + p.y + 'px;' +
        'width:' + p.size + 'px;' +
        'height:' + p.size + 'px;' +
        '--petal-rot:' + p.rotation + 'deg;' +
        '--petal-opacity:' + p.opacity + ';';
      el.innerHTML = '<img src="' + p.petalImg + '" alt="">';
      fragment.appendChild(el);

      // 延迟显现
      setTimeout(function() {
        el.classList.add('visible');
        // 显现完成后切换到持续摇摆
        setTimeout(function() {
          el.classList.remove('visible');
          el.classList.add('floating');
          el.style.opacity = p.opacity;
          el.style.transform = 'scale(1) rotate(' + p.rotation + 'deg)';
        }, 850);
      }, p.delay * 1000);
    });

    trailContainer.appendChild(fragment);
  }

  // ==========================================
  // Canvas 粒子系统 — 性能优化版
  // Canvas 为 absolute 定位，花瓣使用页面坐标（跟随滚动）
  // 去掉 ctx.filter blur，用 size + alpha 模拟景深
  // 粒子按 layer 分三组，无需每帧排序
  // 只绘制视口可见区域的粒子
  // ==========================================
  function setupCanvas() {
    var c = document.getElementById('particle-canvas');
    if (!c) return;
    state.particleCanvas = c;
    state.particleCtx = c.getContext('2d');
    // 分层存储粒子：[远景, 中景, 近景]
    state.particleLayers = [[], [], []];
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas() {
    if (!state.particleCanvas) return;
    var container = document.getElementById('map-container');
    if (!container) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = container.offsetWidth;
    var h = container.scrollHeight || container.offsetHeight;
    state.particleCanvas.width = w * dpr;
    state.particleCanvas.height = h * dpr;
    state.particleCanvas.style.width = w + 'px';
    state.particleCanvas.style.height = h + 'px';
    if (state.particleCtx) state.particleCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function startParticleLoop() {
    (function loop() {
      requestAnimationFrame(loop);
      updateParticles();
      drawParticles();
    })();
  }

  function updateParticles() {
    var time = Date.now() * 0.001;
    var layers = state.particleLayers;
    if (!layers) return;
    for (var li = 0; li < 3; li++) {
      var arr = layers[li];
      for (var i = arr.length - 1; i >= 0; i--) {
        var p = arr[i];
        p.life -= 0.0018;
        if (p.life <= 0) { arr.splice(i, 1); continue; }

        var drag = li === 0 ? 0.96 : (li === 1 ? 0.975 : 0.965);
        p.vx *= drag;
        p.vy *= drag;
        p.vy += 0.006;

        var sway = Math.sin(time * p.swayFreq + p.swayPhase) * p.swayAmp;
        p.x += p.vx + sway;
        p.y += p.vy;
        p.rotation += p.rotSpeed;
      }
    }
  }

  function drawParticles() {
    var ctx = state.particleCtx;
    if (!ctx) return;
    var layers = state.particleLayers;
    if (!layers) return;

    // 视口裁剪：只绘制当前可见区域 ± 余量
    var scrollY = window.pageYOffset || document.documentElement.scrollTop;
    var vh = window.innerHeight;
    var viewTop = scrollY - 100;
    var viewBottom = scrollY + vh + 100;
    var canvasW = state.particleCanvas.width / (Math.min(window.devicePixelRatio || 1, 2));

    // 只清除视口对应的 Canvas 区域（避免清除整个 3900px 高的画布）
    ctx.clearRect(0, viewTop, canvasW, viewBottom - viewTop);

    // 按层级渲染：远景(0) → 中景(1) → 近景(2)
    for (var li = 0; li < 3; li++) {
      var arr = layers[li];
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        // 视口裁剪
        if (p.y < viewTop || p.y > viewBottom) continue;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);

        var lifeAlpha = Math.min(p.life * 1.5, 1);
        var fadeIn = Math.min((1.2 + p.maxLife * 0.5 - p.life) / 0.15, 1);
        var alpha = lifeAlpha * fadeIn;

        // 用透明度模拟景深（无 blur，零开销）
        if (li === 0) {
          ctx.globalAlpha = alpha * 0.35;
        } else if (li === 1) {
          ctx.globalAlpha = alpha * 0.75;
        } else {
          ctx.globalAlpha = alpha * 0.55;
        }

        if (p.img && p.img.complete && p.img.naturalWidth > 0) {
          var s = p.size * 2;
          ctx.drawImage(p.img, -s / 2, -s / 2, s, s);
        } else {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          var s2 = p.size;
          ctx.moveTo(0, -s2);
          ctx.bezierCurveTo(s2 * 0.8, -s2 * 0.8, s2, s2 * 0.3, 0, s2);
          ctx.bezierCurveTo(-s2, s2 * 0.3, -s2 * 0.8, -s2 * 0.8, 0, -s2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  function emitParticles(cityNode, cityIndex) {
    var city = CITIES[cityIndex];
    if (!city) return;

    // 使用页面坐标（相对于 map-container），而不是视口坐标
    var flowerEl = cityNode.querySelector('.flower-container');
    var container = document.getElementById('map-container');
    if (!flowerEl || !container) return;
    var containerRect = container.getBoundingClientRect();
    var flowerRect = flowerEl.getBoundingClientRect();
    var cx = flowerRect.left - containerRect.left + flowerRect.width / 2;
    var cy = flowerRect.top - containerRect.top + flowerRect.height / 2;
    var petalImg = state.petalImages[city.id];

    // 三层景深配置：[远景, 中景, 近景]（精简数量）
    // 凤凰木(广州, index=6) 花瓣更少更小
    var isDelonix = (cityIndex === 6);
    var layerConfigs = [
      { layer: 0, sizeMin: isDelonix ? 3 : 4,  sizeMax: isDelonix ? 6 : 8,  speedMin: 1.0, speedMax: 3.5, count: isDelonix ? 3 : 6 },
      { layer: 1, sizeMin: isDelonix ? 5 : 8,  sizeMax: isDelonix ? 10 : 16, speedMin: 1.2, speedMax: 4.0, count: isDelonix ? 5 : 8 },
      { layer: 2, sizeMin: isDelonix ? 8 : 14, sizeMax: isDelonix ? 14 : 22, speedMin: 0.8, speedMax: 2.5, count: isDelonix ? 2 : 4 }
    ];

    function burst(delay, scale) {
      setTimeout(function() {
        for (var li = 0; li < layerConfigs.length; li++) {
          var L = layerConfigs[li];
          var cnt = Math.round(L.count * scale);
          for (var i = 0; i < cnt; i++) {
            var angle = Math.random() * Math.PI * 2;
            var speed = L.speedMin + Math.random() * (L.speedMax - L.speedMin);
            var vx = Math.cos(angle) * speed;
            var vy = Math.sin(angle) * speed;
            vy -= 0.8 + Math.random() * 1.0;

            var maxLife = 1.0 + Math.random() * 0.6;
            // 直接按 layer 分组存储
            state.particleLayers[L.layer].push({
              x: cx + (Math.random() - 0.5) * 30,
              y: cy + (Math.random() - 0.5) * 20,
              vx: vx,
              vy: vy,
              size: L.sizeMin + Math.random() * (L.sizeMax - L.sizeMin),
              color: city.colors[Math.floor(Math.random() * city.colors.length)],
              img: petalImg,
              rotation: Math.random() * Math.PI * 2,
              rotSpeed: (Math.random() - 0.5) * 0.03,
              life: maxLife,
              maxLife: maxLife,
              swayFreq: 1.2 + Math.random() * 2.5,
              swayPhase: Math.random() * Math.PI * 2,
              swayAmp: 0.15 + Math.random() * 0.5
            });
          }
        }
      }, delay);
    }

    burst(0, 1.0);
    burst(250, 0.8);
    burst(600, 0.6);
    burst(1000, 0.4);
    burst(1600, 0.3);
  }

  // ==========================================
  // CSS 粒子（花朵周围小花瓣）
  // ==========================================
  function createBloomParticles(node, idx) {
    var city = CITIES[idx];
    if (!city) return;
    var c = node.querySelector('.bloom-particles');
    if (!c) return;
    c.innerHTML = '';

    for (var i = 0; i < 14; i++) {
      var p = document.createElement('div');
      p.className = 'bloom-particle';
      var sz = 5 + Math.random() * 10;
      var angle = (Math.PI * 2 / 14) * i + (Math.random() - 0.5) * 0.6;
      var dist = 35 + Math.random() * 55;
      p.style.cssText =
        'left:50%;top:50%;width:' + sz + 'px;height:' + sz + 'px;' +
        'background:' + city.colors[Math.floor(Math.random() * city.colors.length)] + ';' +
        '--tx:' + (Math.cos(angle) * dist) + 'px;' +
        '--tfy:' + (Math.sin(angle) * dist - 15) + 'px;' +
        '--tr:' + ((Math.random() - 0.5) * 360) + 'deg;' +
        'animation-delay:' + (Math.random() * 0.3) + 's;';
      c.appendChild(p);
    }
  }

  // ==========================================
  // 元素缓存
  // ==========================================
  function cacheElements() {
    state.cityNodes = [].slice.call(document.querySelectorAll('.city-node'));
  }

  // ==========================================
  // 进度点
  // ==========================================
  function createProgressDots() {
    var dc = document.getElementById('progress-dots');
    if (!dc) return;
    for (var i = 0; i < CITIES.length; i++) {
      var d = document.createElement('div');
      d.className = 'progress-dot';
      d.title = CITIES[i].name;
      dc.appendChild(d);
      state.progressDots.push(d);
      (function(idx) {
        d.addEventListener('click', function() {
          var n = state.cityNodes[idx];
          if (n) window.scrollTo({ top: n.offsetTop - window.innerHeight / 3, behavior: 'smooth' });
        });
      })(i);
    }
  }

  // ==========================================
  // Intersection Observer — 自动绽放
  // ==========================================
  function setupIntersectionObserver() {
    if (!('IntersectionObserver' in window)) {
      window.addEventListener('scroll', function() {
        var vh = window.innerHeight;
        state.cityNodes.forEach(function(n, i) {
          var r = n.getBoundingClientRect();
          if (r.top < vh * 0.7 && r.bottom > vh * 0.2) triggerBloom(n, i);
        });
      }, { passive: true });
      return;
    }

    var obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(e) {
        if (e.isIntersecting && e.intersectionRatio >= 0.3) {
          var n = e.target;
          triggerBloom(n, parseInt(n.getAttribute('data-index'), 10));
        }
      });
    }, {
      threshold: [0, 0.2, 0.3, 0.5, 0.7],
      rootMargin: '-5% 0px -15% 0px'
    });

    state.cityNodes.forEach(function(n) { obs.observe(n); });
  }

  // ==========================================
  // 触发绽放
  // ==========================================
  function triggerBloom(node, index) {
    if (state.bloomedCities[index]) return;
    // 开屏还在显示时不触发任何绽放
    if (state.introVisible) return;
    state.bloomedCities[index] = true;

    node.classList.add('bloomed');
    createBloomParticles(node, index);

    setTimeout(function() { emitParticles(node, index); }, 250);
    setTimeout(function() { emitParticles(node, index); }, 600);

    updateProgress(index);

    if (navigator.vibrate) navigator.vibrate(25);

    // 三亚（最后一个城市）绽放后，显示花瓣雨引导区
    if (index === 7) {
      setTimeout(showPetalRainGuide, 1500);
    }
  }

  // ==========================================
  // 更新进度
  // ==========================================
  function updateProgress(idx) {
    var fill = document.getElementById('progress-fill');
    if (fill) fill.style.height = ((idx + 1) / CITIES.length * 100) + '%';
    for (var i = 0; i <= idx; i++) {
      if (state.progressDots[i]) state.progressDots[i].classList.add('active');
    }
  }

  // ==========================================
  // 事件监听
  // ==========================================
  function setupEventListeners() {
    state.cityNodes.forEach(function(n, i) {
      n.addEventListener('click', function() { triggerBloom(n, i); });
    });

    // 花朵图片映射（用于浮层水印）
    var bloomImgMap = {};
    CITIES.forEach(function(c) {
      bloomImgMap[c.id] = c.petalImg.replace('petal-', 'bloom-');
    });

    // 赏花地浮层：点击 city-card 弹出
    var spotOverlay = document.getElementById('spot-overlay');
    document.querySelectorAll('.city-card-btn').forEach(function(card) {
      card.addEventListener('click', function(e) {
        e.stopPropagation();
        var node = card.closest('.city-node');
        var idx = parseInt(node.getAttribute('data-index'), 10);
        var city = CITIES[idx];
        var spots = (node.getAttribute('data-spots') || '').split('|');
        if (!spotOverlay || !city) return;

        spotOverlay.querySelector('.spot-city-name').textContent = city.name;
        spotOverlay.querySelector('.spot-flower-name').textContent = city.flower;
        // 设置水印
        var watermark = spotOverlay.querySelector('.spot-watermark');
        if (watermark) {
          watermark.style.backgroundImage = 'url(' + (bloomImgMap[city.id] || '') + ')';
        }
        var list = spotOverlay.querySelector('.spot-list');
        list.innerHTML = '';
        spots.forEach(function(s) {
          if (!s.trim()) return;
          var li = document.createElement('li');
          li.textContent = s.trim();
          list.appendChild(li);
        });
        spotOverlay.style.display = '';
        spotOverlay.offsetHeight;
        spotOverlay.classList.add('visible');
      });
    });

    // 关闭浮层
    if (spotOverlay) {
      spotOverlay.querySelector('.spot-close').addEventListener('click', function() {
        spotOverlay.classList.remove('visible');
        setTimeout(function() { spotOverlay.style.display = 'none'; }, 300);
      });
      spotOverlay.addEventListener('click', function(e) {
        if (e.target === spotOverlay) {
          spotOverlay.classList.remove('visible');
          setTimeout(function() { spotOverlay.style.display = 'none'; }, 300);
        }
      });
    }

    var dirEl = document.querySelector('.direction-indicator');
    var showing = false;
    var hideTimer = null;
    window.addEventListener('scroll', function() {
      if (!state.introVisible && dirEl) {
        if (!showing) { dirEl.style.opacity = '0.6'; showing = true; }
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function() {
          dirEl.style.opacity = '0';
          showing = false;
        }, 1500);
      }
    }, { passive: true });
  }

  // ==========================================
  // 花瓣雨引导区
  // ==========================================
  function showPetalRainGuide() {
    var guide = document.getElementById('petal-rain-guide');
    if (!guide) return;
    guide.style.display = '';
    guide.offsetHeight;
    guide.classList.add('visible');

    var triggered = false;

    // 按钮点击直接启动 AR 花瓣雨（权限请求在用户交互上下文中）
    var btnRain = document.getElementById('btn-petal-rain');
    if (btnRain) {
      var handler = function(e) {
        e.preventDefault();
        if (triggered) return;
        triggered = true;
        startPetalRainAR();
      };
      btnRain.addEventListener('click', handler);
      btnRain.addEventListener('touchend', handler);
    }
  }

  // ==========================================
  // AR 花瓣雨 — 直接在本页启动
  // 在用户点击「开启花雨」的交互上下文中请求权限
  // ==========================================
  var arStarted = false;

  async function startPetalRainAR() {
    if (arStarted) return;
    arStarted = true;

    var btnRain = document.getElementById('btn-petal-rain');
    if (btnRain) {
      btnRain.disabled = true;
      btnRain.textContent = '正在请求权限...';
    }

    var isWx = /MicroMessenger/i.test(navigator.userAgent);

    try {
      // === 1. 陀螺仪权限 ===
      var gyroGranted = false;
      if (window.DeviceOrientationEvent) {
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
          try {
            var perm = await DeviceOrientationEvent.requestPermission();
            gyroGranted = (perm === 'granted');
          } catch (err) {
            console.log('陀螺仪权限错误:', err.message);
          }
        } else {
          gyroGranted = true;
        }
      }

      // === 2. 摄像头权限 ===
      var cameraStream = null;
      async function tryGetCamera(retries) {
        for (var attempt = 0; attempt <= retries; attempt++) {
          if (attempt > 0) await new Promise(function(r) { setTimeout(r, 800); });
          try {
            return await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
              audio: false
            });
          } catch (err) {
            try {
              return await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
              });
            } catch (e2) {
              try {
                return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
              } catch (e3) {
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
      }

      if (btnRain) btnRain.textContent = '正在加载...';

      // === 3. 隐藏地图，显示 AR 场景 ===
      var guide = document.getElementById('petal-rain-guide');
      if (guide) { guide.classList.remove('visible'); guide.style.display = 'none'; }

      var mapContainer = document.getElementById('map-container');
      var progressBar = document.getElementById('progress-bar');
      var arScene = document.getElementById('ar-scene');

      // 全屏过渡：淡出地图
      if (mapContainer) { mapContainer.style.transition = 'opacity 0.6s ease'; mapContainer.style.opacity = '0'; }
      if (progressBar) { progressBar.style.transition = 'opacity 0.3s ease'; progressBar.style.opacity = '0'; }

      await new Promise(function(r) { setTimeout(r, 600); });

      if (mapContainer) mapContainer.style.display = 'none';
      if (progressBar) progressBar.style.display = 'none';
      // 防止地图的 body 样式影响 AR
      document.body.style.overflow = 'hidden';
      document.body.style.background = '#000';

      if (arScene) arScene.classList.remove('hidden');

      // === 4. 初始化花瓣雨模块 ===
      var deviceTier = new DeviceTier();
      var tierConfig = deviceTier.getRenderConfig();

      // 摄像头
      var cameraModule = new CameraManager();
      if (cameraStream) {
        cameraModule.initWithStream(cameraStream);
      } else {
        cameraModule._showFallback();
      }

      // 陀螺仪
      var gyroscope = new GyroscopeManager();
      await gyroscope.initWithPermission(gyroGranted);

      // 花瓣粒子系统
      var particles = null;
      var segmentation = null;
      var bodyCollision = null;

      if (tierConfig.useCSSFallback) {
        // 极低端设备 CSS 花瓣兜底
        _createCSSPetals();
      } else {
        particles = new PetalParticleSystem();
        particles.tierConfig = tierConfig;
        // 花瓣纹理路径需要指向 CDN（不是本地相对路径）
        particles.petalTexturePaths = [
          'img/petal1v2.png', 'img/petal2v2.png', 'img/petal3v2.png', 'img/petal4v2.png',
          'img/petal5v2.png', 'img/petal6v2.png', 'img/petal7v2.png', 'img/petal8v2.png'
        ];
        particles.init();

        var isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
        var initialCount = tierConfig.petalCount;
        if (isMobile && deviceTier.tier === 'high') initialCount = 2000;
        particles.petalCount = initialCount;
        var $petalDensity = document.getElementById('petal-density');
        if ($petalDensity) $petalDensity.value = initialCount;
        if (deviceTier.tier === 'low' && $petalDensity) $petalDensity.max = 1500;
        else if (deviceTier.tier === 'medium' && $petalDensity) $petalDensity.max = 3000;

        // CSS blur 降级
        if (!tierConfig.enableCSSBlur) {
          ['canvas-far', 'canvas-mid', 'canvas-near'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) { el.style.filter = 'none'; el.style.webkitFilter = 'none'; }
          });
        } else if (deviceTier.tier === 'medium') {
          var farEl = document.getElementById('canvas-far');
          var midEl = document.getElementById('canvas-mid');
          var nearEl = document.getElementById('canvas-near');
          if (farEl) { farEl.style.filter = 'blur(' + tierConfig.cssBlurFar + 'px)'; }
          if (midEl) { midEl.style.filter = 'blur(' + tierConfig.cssBlurMid + 'px)'; }
          if (nearEl) { nearEl.style.filter = 'blur(' + tierConfig.cssBlurNear + 'px)'; }
        }

        // 人体分割
        bodyCollision = new BodyCollisionDetector();
        if (cameraStream && tierConfig.enableSegmentation) {
          segmentation = new PersonSegmentation();
          if (tierConfig.segmentationFrameSkip > 0) {
            segmentation._tierFrameSkip = tierConfig.segmentationFrameSkip;
          }
          var segOk = await segmentation.init();
          if (segOk) {
            if (segmentation._tierFrameSkip && isMobile) {
              segmentation.frameSkip = Math.max(segmentation.frameSkip, segmentation._tierFrameSkip);
            }
            segmentation.bodyCollision = bodyCollision;
            segmentation.start();
            particles.bodyCollision = bodyCollision;
            document.getElementById('canvas-person').style.display = 'block';
          } else {
            segmentation = null;
          }
        }
      }

      // minimal 模式隐藏不需要的控件
      if (tierConfig.useCSSFallback) {
        var petalCtrl = document.getElementById('petal-count-control');
        if (petalCtrl) petalCtrl.style.display = 'none';
        var windBtn = document.getElementById('btn-wind');
        if (windBtn) windBtn.parentElement.style.display = 'none';
      }

      // === 5. 初始化拍照/录像 ===
      var capture = new CaptureManager();
      capture.cameraManager = cameraModule;
      capture.deviceTier = deviceTier.tier;
      if (particles) capture.particleSystem = particles;
      if (segmentation) capture.segmentation = segmentation;
      capture.init();
      if (particles) particles.captureManager = capture;

      window._gyroscope = gyroscope;

      var btnSwitch = document.getElementById('btn-switch-camera');
      if (!cameraModule.hasCamera && btnSwitch) {
        btnSwitch.classList.add('hidden');
      }

      // === 6. 启动动画循环 ===
      var animationId = null;
      function startAnimationLoop() {
        function loop() {
          animationId = requestAnimationFrame(loop);
          if (gyroscope) gyroscope.update();
          if (particles) particles.update(gyroscope ? gyroscope.getCameraData() : null);
          if (segmentation) segmentation.update();
        }
        loop();
      }
      startAnimationLoop();

      setInterval(function() {
        if (particles) particles.autoTunePerformance();
      }, 2000);

      // === 7. 绑定 AR 场景 UI 事件 ===
      if (btnSwitch) {
        var switchHandler = function(e) {
          e.preventDefault();
          if (capture && capture.isRecording) return;
          if (cameraModule) cameraModule.switchCamera();
        };
        btnSwitch.addEventListener('click', switchHandler);
        btnSwitch.addEventListener('touchend', switchHandler);
      }

      var $petalDensityAR = document.getElementById('petal-density');
      if ($petalDensityAR) {
        $petalDensityAR.addEventListener('input', function(e) {
          var count = parseInt(e.target.value);
          if (particles) particles.setPetalCount(count);
          if (capture) capture.resetMotionBlurHistory();
        });
      }

      var $btnWind = document.getElementById('btn-wind');
      if ($btnWind) {
        var windHandler = function(e) {
          e.preventDefault();
          if (!particles) return;
          if (capture && capture.isRecording) return;
          particles.triggerWindGust();
          $btnWind.classList.add('wind-active');
          var dur = (particles._userGust && particles._userGust.duration) || 4;
          setTimeout(function() { $btnWind.classList.remove('wind-active'); }, dur * 1000);
        };
        $btnWind.addEventListener('click', windHandler);
        $btnWind.addEventListener('touchend', windHandler);
      }

      // 页面可见性控制
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
          if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
        } else {
          if (!animationId && particles) { particles.clock.getDelta(); startAnimationLoop(); }
        }
      });

    } catch (err) {
      console.error('AR 启动失败:', err);
      if (btnRain) {
        btnRain.disabled = false;
        btnRain.textContent = '重试';
        arStarted = false;
      }
    }
  }

  // CSS 花瓣兜底（极低端设备）
  function _createCSSPetals() {
    var container = document.createElement('div');
    container.className = 'css-petals-container';
    var sceneEl = document.getElementById('ar-scene');
    if (!sceneEl) return;
    sceneEl.appendChild(container);
    for (var i = 0; i < 30; i++) {
      var petal = document.createElement('div');
      petal.className = 'css-petal';
      var size = 12 + Math.random() * 16;
      petal.style.cssText = 'width:' + size + 'px;height:' + size + 'px;left:' + (Math.random() * 100) + '%;animation-duration:' + (6 + Math.random() * 6) + 's;animation-delay:' + (Math.random() * 8) + 's;opacity:' + (0.4 + Math.random() * 0.4) + ';';
      container.appendChild(petal);
    }
  }

  // ==========================================
  // 装饰小花
  // ==========================================
  function addDecoFlowers() {
    var c = document.getElementById('cities');
    if (!c) return;
    var decos = [
      { top: 400, left: '72%', color: '#c9a0dc', size: 8, rot: 30 },
      { top: 500, left: '22%', color: '#f8dfe8', size: 10, rot: -20 },
      { top: 800, left: '78%', color: '#fdd9e4', size: 7, rot: 45 },
      { top: 1150, left: '18%', color: '#ffd700', size: 9, rot: -15 },
      { top: 1350, left: '82%', color: '#f2a0b0', size: 8, rot: 60 },
      { top: 1750, left: '22%', color: '#f8b4c8', size: 10, rot: -40 },
      { top: 2150, left: '80%', color: '#ffd700', size: 7, rot: 25 },
      { top: 2300, left: '15%', color: '#f06888', size: 9, rot: -30 },
      { top: 2650, left: '84%', color: '#f06030', size: 8, rot: 50 },
      { top: 2950, left: '20%', color: '#d83088', size: 10, rot: -45 },
      { top: 3150, left: '78%', color: '#f040a0', size: 7, rot: 35 },
      { top: 3450, left: '25%', color: '#c9a0dc', size: 9, rot: -25 },
    ];

    decos.forEach(function(d) {
      var el = document.createElement('div');
      el.className = 'deco-flower';
      el.style.cssText = 'top:' + d.top + 'px;left:' + d.left + ';';
      el.innerHTML = '<svg width="' + (d.size * 2) + '" height="' + (d.size * 2) + '" viewBox="0 0 20 20" style="transform:rotate(' + d.rot + 'deg)">' +
        '<circle cx="10" cy="5" r="4" fill="' + d.color + '" opacity="0.5"/>' +
        '<circle cx="15" cy="10" r="4" fill="' + d.color + '" opacity="0.4"/>' +
        '<circle cx="10" cy="15" r="4" fill="' + d.color + '" opacity="0.5"/>' +
        '<circle cx="5" cy="10" r="4" fill="' + d.color + '" opacity="0.4"/>' +
        '<circle cx="10" cy="10" r="2.5" fill="#f5d76e" opacity="0.6"/></svg>';
      c.appendChild(el);

      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function(entries, obs) {
          if (entries[0].isIntersecting) { el.classList.add('visible'); obs.unobserve(el); }
        }, { threshold: 0.1 }).observe(el);
      } else {
        el.classList.add('visible');
      }
    });
  }

  // ==========================================
  // 启动
  // ==========================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
