/**
 * 2D 停留花瓣系统
 * 
 * 独立于 3D 花瓣粒子系统，用 Canvas 2D 在人物遮罩层上方绘制。
 * 花瓣从屏幕上方自然飘落，碰到人物蒙版上边缘时停留在身体/手上。
 * 
 * 生命周期：
 *   1. 生成：屏幕上方（或左右上方）随机位置出生
 *   2. 飘落：2D 物理模拟（带摇摆、旋转，和 3D 花瓣风格一致）
 *   3. 碰撞：每帧检查花瓣 2D 坐标是否碰到蒙版上边缘
 *   4. 停留：碰到后减速 → 停在人物轮廓上，轻微晃动
 *   5. 滑落：几秒后自然滑落或被阵风吹走
 */
class RestingPetalSystem {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    
    // 花瓣贴图（复用主系统的 1.png ~ 8.png）
    this.petalImages = [];
    this.imagesLoaded = false;
    
    // 飘落中的花瓣
    this.fallingPetals = [];
    // 停留中的花瓣
    this.restingPetals = [];
    
    // 碰撞检测器引用（外部注入）
    this.bodyCollision = null;
    
    // 配置
    this.config = {
      maxFalling: 8,          // 同时飘落中的最大数量
      maxResting: 25,         // 同时停留的最大数量
      spawnInterval: 0.4,     // 生成间隔（秒）
      spawnChance: 0.6,       // 每次间隔的生成概率
      
      // 飘落物理
      fallSpeedMin: 80,       // 最慢下落速度（像素/秒）
      fallSpeedMax: 160,      // 最快下落速度
      swayAmplitude: 40,      // 摇摆幅度（像素）
      swayFrequency: 1.5,     // 摇摆频率
      rotationSpeed: 1.5,     // 旋转速度（弧度/秒）
      
      // 花瓣大小
      sizeMin: 20,            // 最小尺寸（像素）
      sizeMax: 38,            // 最大尺寸
      
      // 停留
      restDurationMin: 3,     // 最短停留（秒）
      restDurationMax: 8,     // 最长停留
      restJitterAmp: 1.5,     // 停留时的晃动幅度（像素）
      
      // 滑落
      slideFallSpeed: 120,    // 滑落速度（像素/秒）
      slideAccel: 200,        // 滑落加速度
      slideFadeSpeed: 1.5,    // 滑落时淡出速度
    };
    
    this.spawnTimer = 0;
    this.elapsed = 0;
    
    // 屏幕尺寸
    this.screenW = window.innerWidth;
    this.screenH = window.innerHeight;
  }
  
  init() {
    // 获取 canvas
    this.canvas = document.getElementById('canvas-resting');
    if (!this.canvas) return false;
    
    this.ctx = this.canvas.getContext('2d');
    this._resize();
    window.addEventListener('resize', () => this._resize());
    
    // 加载花瓣贴图
    this._loadImages();
    
    return true;
  }
  
  _resize() {
    this.screenW = window.innerWidth;
    this.screenH = window.innerHeight;
    if (this.canvas) {
      this.canvas.width = this.screenW;
      this.canvas.height = this.screenH;
    }
  }
  
  _loadImages() {
    const paths = ['p1.png', 'p2.png', 'p3.png', 'p4.png', 'p5.png', 'p6.png', 'p7.png', 'p8.png'];
    let loaded = 0;
    
    paths.forEach((path) => {
      const img = new Image();
      img.onload = () => {
        loaded++;
        if (loaded === paths.length) {
          this.imagesLoaded = true;
          console.log('停留花瓣贴图加载完成');
        }
      };
      img.onerror = () => {
        loaded++;
        if (loaded === paths.length) this.imagesLoaded = true;
      };
      img.src = path;
      this.petalImages.push(img);
    });
  }
  
  /**
   * 每帧更新
   * @param {number} delta - 帧间隔（秒）
   */
  update(delta) {
    if (!this.imagesLoaded || !this.ctx) return;
    
    delta = Math.min(delta, 0.05);
    this.elapsed += delta;
    
    const collisionActive = this.bodyCollision && this.bodyCollision.isActive;
    
    // 生成新的飘落花瓣 — 始终生成，不依赖碰撞状态
    this.spawnTimer -= delta;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = this.config.spawnInterval;
      if (this.fallingPetals.length < this.config.maxFalling && Math.random() < this.config.spawnChance) {
        this._spawnFalling();
      }
    }
    
    // 更新飘落花瓣
    this._updateFalling(delta, collisionActive);
    
    // 更新停留花瓣
    this._updateResting(delta, collisionActive);
    
    // 绘制
    this._draw();
  }
  
  _spawnFalling() {
    const cfg = this.config;
    const imgIndex = Math.floor(Math.random() * this.petalImages.length);
    const size = cfg.sizeMin + Math.random() * (cfg.sizeMax - cfg.sizeMin);
    
    // 从屏幕上方生成，x 位置随机
    // 有一定概率从左右两侧上方飘入
    let startX, startY;
    const side = Math.random();
    if (side < 0.15) {
      // 从左上方飘入
      startX = -size;
      startY = Math.random() * this.screenH * 0.3;
    } else if (side < 0.3) {
      // 从右上方飘入
      startX = this.screenW + size;
      startY = Math.random() * this.screenH * 0.3;
    } else {
      // 从正上方飘入
      startX = Math.random() * this.screenW;
      startY = -size - Math.random() * 60;
    }
    
    this.fallingPetals.push({
      x: startX,
      y: startY,
      size: size,
      imgIndex: imgIndex,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * cfg.rotationSpeed * 2,
      fallSpeed: cfg.fallSpeedMin + Math.random() * (cfg.fallSpeedMax - cfg.fallSpeedMin),
      swayPhase: Math.random() * Math.PI * 2,
      swayAmp: cfg.swayAmplitude * (0.5 + Math.random() * 0.5),
      swayFreq: cfg.swayFrequency * (0.7 + Math.random() * 0.6),
      driftX: (side < 0.15) ? (30 + Math.random() * 50) : (side < 0.3) ? -(30 + Math.random() * 50) : (Math.random() - 0.5) * 20,
      opacity: 0,        // 从透明渐入
      fadeIn: true,
      scale: 0.8 + Math.random() * 0.4,
    });
  }
  
  _updateFalling(delta, collisionActive) {
    const cfg = this.config;
    const toRemove = [];
    
    for (let i = 0; i < this.fallingPetals.length; i++) {
      const p = this.fallingPetals[i];
      
      // 渐入
      if (p.fadeIn) {
        p.opacity += delta * 3;
        if (p.opacity >= 0.9) {
          p.opacity = 0.9;
          p.fadeIn = false;
        }
      }
      
      // 下落
      p.y += p.fallSpeed * delta;
      
      // 摇摆
      p.x += Math.sin(this.elapsed * p.swayFreq + p.swayPhase) * p.swayAmp * delta;
      
      // 横向漂移
      p.x += p.driftX * delta;
      // 漂移逐渐减弱
      p.driftX *= 0.995;
      
      // 旋转
      p.rotation += p.rotSpeed * delta;
      
      // 碰撞检测
      if (collisionActive && this.restingPetals.length < cfg.maxResting) {
        const cx = p.x + p.size * 0.5;
        const cy = p.y + p.size * 0.5;
        
        // 调试：每隔一段时间打印花瓣位置和碰撞结果
        if (!this._debugTimer) this._debugTimer = 0;
        this._debugTimer += delta;
        if (this._debugTimer > 2) {
          this._debugTimer = 0;
          const testResult = this.bodyCollision.testPoint(cx, cy);
          const isActive = this.bodyCollision.isActive;
          const hasData = this.bodyCollision.hasValidData;
          console.log(`[2D花瓣] 花瓣坐标:(${cx.toFixed(0)},${cy.toFixed(0)}) 屏幕:(${this.screenW}x${this.screenH}) 碰撞结果:${JSON.stringify(testResult)} isActive:${isActive} hasData:${hasData} 飘落中:${this.fallingPetals.length} 停留中:${this.restingPetals.length}`);
        }
        
        const hit = this.bodyCollision.testPoint(cx, cy);
        if (hit.hit) {
          // 碰撞！转为停留状态
          this.restingPetals.push({
            x: p.x,
            y: hit.surfaceY * this.screenH - p.size * 0.3, // 稍微往上偏一点，看起来更自然
            size: p.size,
            imgIndex: p.imgIndex,
            rotation: p.rotation,
            rotSpeed: p.rotSpeed * 0.05, // 大幅减缓旋转
            opacity: p.opacity,
            scale: p.scale,
            restTimer: 0,
            restDuration: cfg.restDurationMin + Math.random() * (cfg.restDurationMax - cfg.restDurationMin),
            jitterPhase: Math.random() * Math.PI * 2,
            state: 'resting', // 'resting' | 'sliding'
            slideSpeed: 0,
            slideOpacity: p.opacity,
          });
          toRemove.push(i);
          continue;
        }
      }
      
      // 飘出屏幕底部 → 移除
      if (p.y > this.screenH + p.size * 2 || p.x < -p.size * 3 || p.x > this.screenW + p.size * 3) {
        toRemove.push(i);
      }
    }
    
    // 反向移除
    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.fallingPetals.splice(toRemove[i], 1);
    }
  }
  
  _updateResting(delta, collisionActive) {
    const cfg = this.config;
    const toRemove = [];
    
    for (let i = 0; i < this.restingPetals.length; i++) {
      const p = this.restingPetals[i];
      
      if (p.state === 'resting') {
        p.restTimer += delta;
        
        // 轻微晃动
        p.x += Math.sin(this.elapsed * 1.2 + p.jitterPhase) * cfg.restJitterAmp * delta;
        p.rotation += p.rotSpeed * delta;
        
        // 检查是否还在人物上
        let shouldSlide = false;
        
        if (p.restTimer > p.restDuration) {
          shouldSlide = true;
        } else if (collisionActive) {
          const cx = p.x + p.size * 0.5;
          const cy = p.y + p.size * 0.5;
          if (!this.bodyCollision.isInsideBody(cx, cy)) {
            shouldSlide = true;
          }
        } else {
          // 碰撞检测不可用了
          shouldSlide = true;
        }
        
        if (shouldSlide) {
          p.state = 'sliding';
          p.slideSpeed = 20 + Math.random() * 30;
          p.slideOpacity = p.opacity;
        }
      }
      
      if (p.state === 'sliding') {
        p.slideSpeed += cfg.slideAccel * delta;
        p.y += p.slideSpeed * delta;
        p.x += (Math.random() - 0.5) * 15 * delta;
        p.rotation += p.rotSpeed * 3 * delta;
        p.slideOpacity -= cfg.slideFadeSpeed * delta;
        p.opacity = Math.max(0, p.slideOpacity);
        
        if (p.opacity <= 0 || p.y > this.screenH + p.size) {
          toRemove.push(i);
        }
      }
    }
    
    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.restingPetals.splice(toRemove[i], 1);
    }
  }
  
  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.screenW, this.screenH);
    
    // 先画停留的（在下层）
    for (const p of this.restingPetals) {
      this._drawPetal(p);
    }
    
    // 再画飘落中的（在上层）
    for (const p of this.fallingPetals) {
      this._drawPetal(p);
    }
  }
  
  _drawPetal(p) {
    const ctx = this.ctx;
    const img = this.petalImages[p.imgIndex];
    if (!img || !img.complete) return;
    
    const s = p.size * p.scale;
    
    ctx.save();
    ctx.globalAlpha = p.opacity;
    ctx.translate(p.x + s * 0.5, p.y + s * 0.5);
    ctx.rotate(p.rotation);
    ctx.drawImage(img, -s * 0.5, -s * 0.5, s, s);
    ctx.restore();
  }
  
  /**
   * 获取当前停留花瓣数量（用于 FPS 计数器显示）
   */
  get restingCount() {
    return this.restingPetals.length;
  }
  
  destroy() {
    this.fallingPetals = [];
    this.restingPetals = [];
    this.petalImages = [];
  }
}
