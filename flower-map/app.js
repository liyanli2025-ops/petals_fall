/* ============================================
   五一花开地图 H5 — 交互逻辑 v3（图片版）
   ============================================ */

(function() {
  'use strict';

  // ==========================================
  // 配置
  // ==========================================
  var CITIES = [
    { id: 'harbin',     name: '哈尔滨', flower: '丁香',   colors: ['#c9a0dc', '#a87cc4', '#d4b8e8', '#b090d0'], petalImg: 'img/petal-lilac.png' },
    { id: 'beijing',    name: '北京',   flower: '玉兰',   colors: ['#fff5f9', '#f8dfe8', '#fce8f0', '#f0d0e0'], petalImg: 'img/petal-magnolia.png' },
    { id: 'luoyang',    name: '洛阳',   flower: '牡丹',   colors: ['#f2a0b0', '#e87890', '#f5c0cc', '#e06080'], petalImg: 'img/petal-peony.png' },
    { id: 'wuhan',      name: '武汉',   flower: '樱花',   colors: ['#fdd9e4', '#f8b4c8', '#fce0ea', '#f5a8c0'], petalImg: 'img/petal-cherry.png' },
    { id: 'wuyuan',     name: '婺源',   flower: '油菜花', colors: ['#ffd700', '#f5c400', '#ffe040', '#e8b800'], petalImg: 'img/petal-rapeseed.png' },
    { id: 'changsha',   name: '长沙',   flower: '杜鹃',   colors: ['#f06888', '#e04868', '#f08898', '#d03858'], petalImg: 'img/petal-azalea.png' },
    { id: 'guangzhou',  name: '广州',   flower: '木棉',   colors: ['#f06030', '#e04820', '#f58050', '#d03818'], petalImg: 'img/petal-kapok.png' },
    { id: 'sanya',      name: '三亚',   flower: '三角梅', colors: ['#f040a0', '#d83088', '#f060b0', '#c02878'], petalImg: 'img/petal-bougainvillea.png' }
  ];

  // ==========================================
  // 状态
  // ==========================================
  var state = {
    introVisible: true,
    bloomedCities: {},
    particleCanvas: null,
    particleCtx: null,
    particles: [],
    cityNodes: [],
    progressDots: [],
    routeDrawn: false,
    petalImages: {} // 预加载的花瓣图片
  };

  // ==========================================
  // 预加载花瓣图片
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
    createIntroPetals();
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
  // 开屏花瓣（单一淡粉色）
  // ==========================================
  function createIntroPetals() {
    var container = document.querySelector('.intro-petals');
    if (!container) return;
    for (var i = 0; i < 35; i++) {
      var p = document.createElement('div');
      p.className = 'intro-petal';
      var size = 20 + Math.random() * 30;
      p.style.cssText =
        'left:' + (Math.random() * 100) + '%;' +
        'width:' + size + 'px;height:' + size + 'px;' +
        'background:rgba(248,180,200,' + (0.4 + Math.random() * 0.3) + ');' +
        'animation-duration:' + (5 + Math.random() * 7) + 's;' +
        'animation-delay:' + (Math.random() * 6) + 's;';
      container.appendChild(p);
    }
  }

  // ==========================================
  // 开屏滑动消失
  // ==========================================
  function setupIntroScroll() {
    var intro = document.getElementById('intro');
    if (!intro) return;

    var dismissed = false;

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

    var arrow = intro.querySelector('.intro-arrow');
    if (arrow) {
      arrow.addEventListener('click', function() {
        if (!dismissed) { dismissed = true; dismissIntro(); }
      });
    }

    intro.addEventListener('click', function() {
      if (!dismissed) { dismissed = true; dismissIntro(); }
    });
  }

  function dismissIntro() {
    var intro = document.getElementById('intro');
    if (!intro) return;

    // 先锁定滚动位置到顶部
    document.body.style.overflow = 'hidden';
    window.scrollTo(0, 0);

    intro.classList.add('fade-out');
    state.introVisible = false;

    var pb = document.getElementById('progress-bar');
    if (pb) pb.classList.add('visible');
    var mc = document.querySelector('.map-container');
    if (mc) mc.classList.add('scrolling');

    setTimeout(animateRoute, 600);

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

    var d = 'M ' + points[0].x + ' ' + (points[0].y - 60);
    for (var j = 0; j < points.length; j++) {
      if (j === 0) {
        var cp1x = points[0].x;
        var cp1y = points[0].y - 30;
        var cp2x = (points[0].x + points[1].x) / 2;
        var cp2y = (points[0].y + points[1].y) / 2 - 40;
        d += ' C ' + cp1x + ' ' + cp1y + ', ' + cp2x + ' ' + cp2y + ', ' + points[0].x + ' ' + points[0].y;
      } else if (j < points.length - 1) {
        var prev = points[j - 1];
        var curr = points[j];
        var next = points[j + 1];
        var cpx1 = curr.x + (curr.x - prev.x) * 0.15;
        var cpy1 = curr.y + (curr.y - prev.y) * 0.05;
        var cpx2 = next.x - (next.x - curr.x) * 0.15;
        var cpy2 = next.y - (next.y - curr.y) * 0.05;
        d += ' C ' + cpx1 + ' ' + cpy1 + ', ' + cpx2 + ' ' + cpy2 + ', ' + next.x + ' ' + next.y;
      }
    }

    var path = document.getElementById('main-route');
    if (path) {
      path.setAttribute('d', d);
    }
  }

  function animateRoute() {
    if (state.routeDrawn) return;
    state.routeDrawn = true;

    var path = document.getElementById('main-route');
    if (!path) return;

    var length = path.getTotalLength();
    path.style.strokeDasharray = length;
    path.style.strokeDashoffset = length;
    path.style.opacity = '0.6';

    path.getBoundingClientRect();

    path.style.transition = 'stroke-dashoffset 3s ease-in-out';
    path.style.strokeDashoffset = '0';

    setTimeout(function() {
      path.style.transition = 'none';
      path.style.strokeDasharray = '12 8';
      path.style.strokeDashoffset = '0';
    }, 3200);
  }

  // ==========================================
  // Canvas 粒子系统 — 图片版
  // ==========================================
  function setupCanvas() {
    var c = document.getElementById('particle-canvas');
    if (!c) return;
    state.particleCanvas = c;
    state.particleCtx = c.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas() {
    if (!state.particleCanvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth;
    var h = window.innerHeight;
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
    for (var i = state.particles.length - 1; i >= 0; i--) {
      var p = state.particles[i];
      p.life -= 0.002;
      if (p.life <= 0) { state.particles.splice(i, 1); continue; }
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.008;
      p.vx += (Math.random() - 0.5) * 0.1;
      p.vx *= 0.998;
      p.rotation += p.rotSpeed;
      p.size *= 0.9995;
    }
  }

  function drawParticles() {
    var ctx = state.particleCtx;
    if (!ctx) return;
    var w = window.innerWidth, h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    for (var i = 0; i < state.particles.length; i++) {
      var p = state.particles[i];
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = Math.min(p.life * 1.2, 0.85);

      if (p.img && p.img.complete && p.img.naturalWidth > 0) {
        // 使用花瓣图片贴图
        var s = p.size * 2;
        ctx.drawImage(p.img, -s / 2, -s / 2, s, s);
      } else {
        // 后备：使用颜色形状
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

  function emitParticles(cityNode, cityIndex) {
    var city = CITIES[cityIndex];
    if (!city) return;
    var rect = cityNode.querySelector('.flower-container').getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var petalImg = state.petalImages[city.id];

    function burst(delay, count) {
      setTimeout(function() {
        for (var i = 0; i < count; i++) {
          var angle = Math.random() * Math.PI * 2;
          var speed = 0.8 + Math.random() * 3;
          state.particles.push({
            x: cx + (Math.random() - 0.5) * 40,
            y: cy + (Math.random() - 0.5) * 40,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 1.5,
            size: 5 + Math.random() * 12,
            color: city.colors[Math.floor(Math.random() * city.colors.length)],
            img: petalImg,
            rotation: Math.random() * Math.PI * 2,
            rotSpeed: (Math.random() - 0.5) * 0.04,
            life: 1.0 + Math.random() * 0.5
          });
        }
      }, delay);
    }

    burst(0, 22);
    burst(300, 16);
    burst(700, 12);
    burst(1200, 10);
    burst(2000, 8);
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

    // 三亚（最后一个城市）绽放后，2秒后自动触发尾部过渡
    if (index === 7) {
      setTimeout(triggerOutroSequence, 2000);
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
  // 尾部自动过渡 — 延时摄影效果
  // 长渐变、几乎不停留、最后淡出到纸纹色再跳转
  // ==========================================
  var outroTriggered = false;

  function triggerOutroSequence() {
    if (outroTriggered) return;
    outroTriggered = true;

    var overlay = document.getElementById('outro-overlay');
    var imgA = document.getElementById('outro-img-a');
    var imgB = document.getElementById('outro-img-b');
    if (!overlay) return;

    var imgs = ['img/1.jpg', 'img/sketch-flowers.jpg', 'img/colored-flowers.jpg'];
    var fadeMs = 500;
    var gapMs = 0;

    // 立即后台预加载跳转页
    var preload = document.createElement('link');
    preload.rel = 'prefetch';
    preload.href = 'https://h5.news.qq.com/qqfile/redian/petals_fall.html';
    document.head.appendChild(preload);

    imgs.forEach(function(s) { var i = new Image(); i.src = s; });

    imgA.src = imgs[0];
    imgA.style.opacity = '1';
    imgB.style.opacity = '0';
    overlay.style.display = '';
    overlay.style.opacity = '0';
    overlay.offsetHeight;
    overlay.style.transition = 'opacity 400ms ease';
    overlay.style.opacity = '1';

    var front = imgA, back = imgB;
    var step = 0;

    function crossfadeNext() {
      step++;
      if (step < imgs.length) {
        back.src = imgs[step];
        back.style.opacity = '1';
        front.style.transition = 'opacity ' + fadeMs + 'ms ease-in-out';
        front.style.opacity = '0';
        setTimeout(function() {
          var tmp = front; front = back; back = tmp;
          crossfadeNext();
        }, fadeMs);
      } else {
        front.style.transition = 'opacity 400ms ease-in-out';
        front.style.opacity = '0';
        // 淡出动画刚开始就跳转（页面已预加载）
        setTimeout(function() {
          window.location.href = 'https://h5.news.qq.com/qqfile/redian/petals_fall.html';
        }, 200);
      }
    }

    setTimeout(crossfadeNext, 400);
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
