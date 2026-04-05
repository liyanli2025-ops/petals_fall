/**
 * 花瓣粒子系统 v11 — 单 WebGL + 三层 2D Canvas 景深版
 * 
 * 架构：1 个隐藏的 WebGL renderer，3 次渲染 pass，
 *       每 pass 的结果 drawImage 到对应的 2D canvas（带 CSS blur）
 * 
 * 这样只用 1 个 WebGL context（+ MediaPipe 1 个 = 总共 2 个），
 * 同时保留了原来的 CSS blur 景深效果。
 */
class PetalParticleSystem {
  constructor() {
    // 隐藏的 WebGL canvas（渲染目标）
    this.canvas = document.getElementById('canvas-petals');
    this.scene = null;
    this.camera = null;
    this.renderer = null;

    // 3 个 2D 显示 canvas（带 CSS blur）
    this.displayLayers = {
      far:  { canvas: document.getElementById('canvas-far'),  ctx: null },
      mid:  { canvas: document.getElementById('canvas-mid'),  ctx: null },
      near: { canvas: document.getElementById('canvas-near'), ctx: null },
    };

    this.petalCount = 3000;
    this.clock = new THREE.Clock();

    this.worldRadius = 35;
    this.fallSpeed = 6.0;

    this.wind = { x: 0.15, z: 0.1, turbulence: 0, time: 0 };
    this.gust = { active: false, strength: 0, direction: 0, timer: 0, interval: 3 + Math.random() * 4 };

    this.cameraWorldPos = { x: 0, y: 0, z: 0 };

    this.petalTexturePaths = [
      'petal1.png', 'petal2.png', 'petal3.png', 'petal4.png',
      'petal5.png', 'petal6.png', 'petal7.png', 'petal8.png'
    ];

    this.petalMaterials = [];
    this.petalGeometries = [];
    this.textureLoader = new THREE.TextureLoader();
    this.ready = false;

    // 8 个逻辑层，映射到 3 个渲染层
    // 减少远景碎片比例，增加中近景可辨认花瓣
    this.layerConfig = {
      dust:     { ratio: 0.08, scaleMin: 0.08, scaleMax: 0.15, radiusMin: 16, radiusMax: 25, renderLayer: 'far',  fallMult: 0.7  },
      veryFar:  { ratio: 0.12, scaleMin: 0.15, scaleMax: 0.25, radiusMin: 12, radiusMax: 18, renderLayer: 'far',  fallMult: 0.8  },
      far:      { ratio: 0.14, scaleMin: 0.22, scaleMax: 0.40, radiusMin: 8,  radiusMax: 13, renderLayer: 'far',  fallMult: 0.9  },
      midFar:   { ratio: 0.14, scaleMin: 0.35, scaleMax: 0.55, radiusMin: 6,  radiusMax: 12, renderLayer: 'far',  fallMult: 1.0  },
      mid:      { ratio: 0.16, scaleMin: 0.45, scaleMax: 0.70, radiusMin: 4,  radiusMax: 9,  renderLayer: 'mid',  fallMult: 1.0  },
      midNear:  { ratio: 0.12, scaleMin: 0.55, scaleMax: 0.80, radiusMin: 3,  radiusMax: 6,  renderLayer: 'mid',  fallMult: 1.05 },
      near:     { ratio: 0.14, scaleMin: 0.60, scaleMax: 0.90, radiusMin: 2,  radiusMax: 5,  renderLayer: 'near', fallMult: 1.1  },
      veryNear: { ratio: 0.10, scaleMin: 0.85, scaleMax: 1.30, radiusMin: 1.2,radiusMax: 3.0,renderLayer: 'near', fallMult: 1.15 },
    };

    // InstancedMesh 按渲染层分组：renderMeshes[renderLayer][matIndex]
    this.renderMeshes = { far: [], mid: [], near: [] };

    this.petalData = [];
    this.petalLayerMap = {};
    this.clusters = [];

    this._tempMatrix = new THREE.Matrix4();
    this._tempPosition = new THREE.Vector3();
    this._tempQuaternion = new THREE.Quaternion();
    this._tempScale = new THREE.Vector3();
    this._tempEuler = new THREE.Euler();

    this.fps = 0;
    this.frameCount = 0;
    this.lastFpsTime = 0;
    this.maxInstancesPerMesh = 0;

    this.bodyCollision = null;
    this._projVec = new THREE.Vector3();
    this.restingCount = 0;
    
    // === 涡流系统（人物大动作触发） ===
    this.vortices = [];           // 活跃涡流列表
    this._maxVortices = 3;        // 最多同时存在的涡流数
    this._vortexCooldown = 0;     // 涡流触发冷却（避免连续触发）
  }

  get petals() {
    return this.petalData;
  }

  init() {
    this.degraded = false;

    this.scene = new THREE.Scene();
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 120);
    this.camera.position.set(0, 0, 0);

    // 初始化 2D 显示层（分辨率匹配 WebGL 的实际像素）
    const dpr = Math.min(window.devicePixelRatio, 2);
    for (const [key, layer] of Object.entries(this.displayLayers)) {
      layer.ctx = layer.canvas.getContext('2d');
      layer.canvas.width = window.innerWidth * dpr;
      layer.canvas.height = window.innerHeight * dpr;
    }

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false
      });
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 提升渲染质量
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.2;
      if (this.renderer.outputColorSpace !== undefined) {
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      }
      // 让隐藏的 canvas 尺寸匹配
      this.canvas.style.display = 'none';
      console.log('单 WebGL context 创建成功');
    } catch (err) {
      console.error('WebGL 上下文创建失败:', err);
      this.degraded = true;
      return this;
    }

    // WebGL context lost/restored
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('WebGL context lost!');
      this._contextLost = true;
      if (this._restoreTimer) clearTimeout(this._restoreTimer);
      this._restoreTimer = setTimeout(() => {
        if (this._contextLost) this._forceRecreateRenderer();
      }, 2000);
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      console.log('WebGL context restored!');
      if (this._restoreTimer) { clearTimeout(this._restoreTimer); this._restoreTimer = null; }
      this._contextLost = false;
      this._forceRecreateRenderer();
    });

    // 光源
    const hemiLight = new THREE.HemisphereLight(0xfff5f0, 0xc8b0ff, 0.6);
    this.scene.add(hemiLight);
    const mainLight = new THREE.DirectionalLight(0xfff0e0, 0.9);
    mainLight.position.set(5, 8, 3);
    this.scene.add(mainLight);
    const fillLight = new THREE.DirectionalLight(0xe0e8ff, 0.35);
    fillLight.position.set(-3, -2, -5);
    this.scene.add(fillLight);
    const backLight = new THREE.PointLight(0xffcccc, 0.5, 40);
    backLight.position.set(0, 5, -8);
    this.scene.add(backLight);

    // 不使用 fog — 景深通过 CSS blur 在 3 个显示层上实现

    this._generateClusters();
    this._loadPetalAssets();
    window.addEventListener('resize', () => this._onResize());

    return this;
  }

  _generateClusters() {
    const count = 15 + Math.floor(Math.random() * 10);
    this.clusters = [];
    for (let i = 0; i < count; i++) {
      const cosTheta = 2 * Math.random() - 1;
      const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
      const phi = Math.random() * Math.PI * 2;
      const r = 5 + Math.random() * 25;
      this.clusters.push({
        x: sinTheta * Math.cos(phi) * r, y: cosTheta * r, z: sinTheta * Math.sin(phi) * r,
        radius: 2 + Math.random() * 6, weight: 0.3 + Math.random() * 0.7,
      });
    }
  }

  /**
   * 对纹理做上采样 + 边缘 RGBA 统一高斯模糊
   * 
   * 核心思路：不只模糊 alpha，而是对 RGBA 四通道统一模糊。
   * 这样边缘半透明区域的颜色会自然扩展（而非截断），
   * 配合 GPU 端的 premultiplyAlpha 实现无缝混合。
   * 
   * 只在"边缘带"区域做模糊，内部完全不透明和外部完全透明区域保持不变。
   */
  _softenTextureAlpha(texture) {
    const img = texture.image;
    if (!img || !img.width || !img.height) return;
    
    const origW = img.width, origH = img.height;
    // 上采样 2 倍（浏览器双线性插值）
    const w = origW * 2, h = origH * 2;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    
    // 提取 RGBA 为浮点数组
    const totalPixels = w * h;
    let r = new Float32Array(totalPixels);
    let g = new Float32Array(totalPixels);
    let b = new Float32Array(totalPixels);
    let a = new Float32Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
      r[i] = data[i * 4] / 255;
      g[i] = data[i * 4 + 1] / 255;
      b[i] = data[i * 4 + 2] / 255;
      a[i] = data[i * 4 + 3] / 255;
    }
    
    // 7×7 高斯 kernel（σ ≈ 1.5，更宽的过渡带）
    const kSize = 7, kHalf = 3;
    const sigma = 1.5;
    const kernel = new Float32Array(kSize * kSize);
    let kSum = 0;
    for (let ky = -kHalf; ky <= kHalf; ky++) {
      for (let kx = -kHalf; kx <= kHalf; kx++) {
        const v = Math.exp(-(kx * kx + ky * ky) / (2 * sigma * sigma));
        kernel[(ky + kHalf) * kSize + (kx + kHalf)] = v;
        kSum += v;
      }
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= kSum;
    
    // 构建边缘 mask：alpha 有变化的区域及其 4px 邻域
    const buildEdgeMask = (alphaArr) => {
      const mask = new Uint8Array(totalPixels);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const av = alphaArr[y * w + x];
          if (av > 0.005 && av < 0.995) { mask[y * w + x] = 1; continue; }
          // 检查 4px 邻域
          let found = false;
          for (let ky = -4; ky <= 4 && !found; ky++) {
            for (let kx = -4; kx <= 4 && !found; kx++) {
              const nx = x + kx, ny = y + ky;
              if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                if (Math.abs(alphaArr[ny * w + nx] - av) > 0.15) found = true;
              }
            }
          }
          if (found) mask[y * w + x] = 1;
        }
      }
      return mask;
    };
    
    // 在边缘带先做颜色扩展：将不透明像素的颜色"渗透"到相邻的透明像素
    // 这样模糊后半透明区域有正确的颜色，而不是混入黑色
    for (let pass = 0; pass < 3; pass++) {
      const newR = new Float32Array(r);
      const newG = new Float32Array(g);
      const newB = new Float32Array(b);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (a[idx] > 0.1) continue; // 已有颜色，跳过
          // 从邻域找最近的不透明像素的颜色
          let bestR = 0, bestG = 0, bestB = 0, bestA = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const nx = x + kx, ny = y + ky;
              if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                const na = a[ny * w + nx];
                if (na > bestA) {
                  bestA = na;
                  bestR = r[ny * w + nx];
                  bestG = g[ny * w + nx];
                  bestB = b[ny * w + nx];
                }
              }
            }
          }
          if (bestA > 0.1) {
            newR[idx] = bestR;
            newG[idx] = bestG;
            newB[idx] = bestB;
          }
        }
      }
      r = newR; g = newG; b = newB;
    }
    
    // 3 pass 7×7 高斯模糊（仅边缘区域，RGBA 四通道同步）
    for (let pass = 0; pass < 3; pass++) {
      const edgeMask = buildEdgeMask(a);
      const nr = new Float32Array(totalPixels);
      const ng = new Float32Array(totalPixels);
      const nb = new Float32Array(totalPixels);
      const na = new Float32Array(totalPixels);
      
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (!edgeMask[idx]) {
            nr[idx] = r[idx]; ng[idx] = g[idx]; nb[idx] = b[idx]; na[idx] = a[idx];
            continue;
          }
          let sr = 0, sg = 0, sb = 0, sa = 0;
          let ki = 0;
          for (let ky = -kHalf; ky <= kHalf; ky++) {
            for (let kx = -kHalf; kx <= kHalf; kx++) {
              const nx = Math.min(w - 1, Math.max(0, x + kx));
              const ny = Math.min(h - 1, Math.max(0, y + ky));
              const nIdx = ny * w + nx;
              const kv = kernel[ki++];
              sr += r[nIdx] * kv;
              sg += g[nIdx] * kv;
              sb += b[nIdx] * kv;
              sa += a[nIdx] * kv;
            }
          }
          nr[idx] = sr; ng[idx] = sg; nb[idx] = sb; na[idx] = sa;
        }
      }
      r = nr; g = ng; b = nb; a = na;
    }
    
    // 写回 RGBA（straight alpha，不做手动 premultiply — 交给 GPU 的 premultiplyAlpha）
    for (let i = 0; i < totalPixels; i++) {
      data[i * 4]     = Math.round(Math.min(1, Math.max(0, r[i])) * 255);
      data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, g[i])) * 255);
      data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, b[i])) * 255);
      data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, a[i])) * 255);
    }
    
    ctx.putImageData(imageData, 0, 0);
    texture.image = canvas;
    texture.needsUpdate = true;
  }

  _loadPetalAssets() {
    // 近景花瓣形状（高细分，有弯曲效果）
    const petalShapes = [
      { w: 0.50, h: 0.35, bendX: 0.12, bendY: 0.06, curl: 0.05, twist: 0.03 },
      { w: 0.44, h: 0.44, bendX: 0.15, bendY: 0.08, curl: 0.07, twist: 0.02 },
      { w: 0.36, h: 0.50, bendX: 0.18, bendY: 0.10, curl: 0.08, twist: 0.04 },
      { w: 0.40, h: 0.28, bendX: 0.10, bendY: 0.05, curl: 0.04, twist: 0.05 },
    ];
    petalShapes.forEach(cfg => {
      const geo = new THREE.PlaneGeometry(cfg.w, cfg.h, 8, 8);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const nx = (x / cfg.w) + 0.5, ny = (y / cfg.h) + 0.5;
        let z = 0;
        z += Math.sin(ny * Math.PI) * cfg.bendX;
        z += Math.sin(nx * Math.PI) * cfg.bendY;
        const edgeDist = Math.min(nx, 1 - nx, ny, 1 - ny);
        z += Math.max(0, 0.15 - edgeDist) * cfg.curl * 8;
        z += x * y * cfg.twist * 4;
        pos.setZ(i, z);
      }
      geo.computeVertexNormals();
      this.petalGeometries.push(geo);
    });

    // 远景花瓣材质（MeshBasicMaterial，无光照计算，纯贴图更干净）
    this.farPetalMaterials = [];

    let loadedCount = 0;
    const total = this.petalTexturePaths.length;
    this.petalTexturePaths.forEach((path) => {
      const texture = this.textureLoader.load(path, () => {
        loadedCount++;
        if (loadedCount === total) this._onAllTexturesLoaded();
      }, undefined, () => {
        loadedCount++;
        if (loadedCount === total) this._onAllTexturesLoaded();
      });
      if (texture.colorSpace !== undefined) texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      // 各向异性过滤：大幅提升斜角查看时的纹理边缘质量
      texture.anisotropy = this.renderer ? this.renderer.capabilities.getMaxAnisotropy() : 4;
      // premultiplied alpha：消除边缘白边/黑边
      texture.premultiplyAlpha = true;
      texture.needsUpdate = true;
      // 近景材质（PhysicalMaterial，有光照质感）
      // 移除 alphaTest 硬裁切，完全依赖 alpha blending 实现柔和边缘
      const mat = new THREE.MeshPhysicalMaterial({
        map: texture, side: THREE.DoubleSide, transparent: true,
        opacity: 0.95, roughness: 0.55, metalness: 0.0, clearcoat: 0.08,
        clearcoatRoughness: 0.4, transmission: 0.05, thickness: 0.35, depthWrite: false,
        premultipliedAlpha: true,
      });
      this.petalMaterials.push(mat);
      // 远景材质（BasicMaterial，纯贴图，同样移除 alphaTest）
      const farMat = new THREE.MeshBasicMaterial({
        map: texture, side: THREE.DoubleSide, transparent: true,
        opacity: 0.9, depthWrite: false,
        premultipliedAlpha: true,
      });
      this.farPetalMaterials.push(farMat);
    });
  }

  _onAllTexturesLoaded() {
    console.log('花瓣贴图加载完成，创建 InstancedMesh...');
    this.ready = true;
    this._createInstancedMeshes(this.petalCount);
  }

  _createInstancedMeshes(totalCount) {
    this._cleanupMeshes();

    // 计算每个渲染层需要多少实例
    const layerCounts = { far: 0, mid: 0, near: 0 };
    for (const cfg of Object.values(this.layerConfig)) {
      layerCounts[cfg.renderLayer] += Math.round(totalCount * cfg.ratio);
    }

    const numMaterials = this.petalMaterials.length;

    for (const renderKey of ['far', 'mid', 'near']) {
      const count = layerCounts[renderKey];
      if (count === 0) continue;
      const perMat = Math.ceil(count / numMaterials) + 10;
      this.maxInstancesPerMesh = Math.max(this.maxInstancesPerMesh, perMat);
      this.renderMeshes[renderKey] = [];
      // 远景层用 farPetalMaterials（BasicMaterial，更干净）
      const mats = (renderKey === 'far' && this.farPetalMaterials && this.farPetalMaterials.length > 0)
        ? this.farPetalMaterials : this.petalMaterials;

      for (let mi = 0; mi < numMaterials; mi++) {
        const geo = this.petalGeometries[mi % this.petalGeometries.length];
        const mesh = new THREE.InstancedMesh(geo, mats[mi], perMat);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.scene.add(mesh);
        this.renderMeshes[renderKey].push(mesh);
      }
    }

    // 生成花瓣数据
    this.petalData = [];
    this.petalLayerMap = {};
    for (const key of Object.keys(this.layerConfig)) this.petalLayerMap[key] = [];

    for (const [key, cfg] of Object.entries(this.layerConfig)) {
      const count = Math.round(totalCount * cfg.ratio);
      for (let i = 0; i < count; i++) this._spawnPetal(key, true);
    }

    this._rebuildAllInstanceMatrices();
  }

  _spawnPetal(layerKey, randomY = false) {
    const cfg = this.layerConfig[layerKey];
    if (!cfg || cfg.ratio === 0) return;
    const matIndex = this.petalData.length % this.petalMaterials.length;
    const scale = cfg.scaleMin + Math.random() * (cfg.scaleMax - cfg.scaleMin);
    const radius = cfg.radiusMin + Math.random() * (cfg.radiusMax - cfg.radiusMin);
    let px, py, pz;
    if (randomY) {
      if (this.clusters.length > 0 && Math.random() < 0.6) {
        const cluster = this.clusters[Math.floor(Math.random() * this.clusters.length)];
        px = cluster.x + (Math.random() - 0.5) * cluster.radius * 2;
        py = cluster.y + (Math.random() - 0.5) * cluster.radius * 2;
        pz = cluster.z + (Math.random() - 0.5) * cluster.radius * 2;
        const dist = Math.sqrt(px * px + py * py + pz * pz);
        if (dist > this.worldRadius) { const s = this.worldRadius / dist * 0.9; px *= s; py *= s; pz *= s; }
      } else {
        // 球形均匀分布
        const phi = Math.random() * Math.PI * 2;
        const cosTheta = 2 * Math.random() - 1;
        const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
        const r = Math.cbrt(Math.random()) * radius;
        px = sinTheta * Math.cos(phi) * r;
        py = sinTheta * Math.sin(phi) * r;
        pz = cosTheta * r;
      }
    } else {
      // recycle 时也用球形分布，偏向上半球（保证持续有花瓣从上方落入）
      const phi = Math.random() * Math.PI * 2;
      // cosTheta 范围 [0, 1]，即上半球
      const cosTheta = Math.random();
      const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
      const r = (0.5 + Math.random() * 0.5) * radius;
      px = this.cameraWorldPos.x + sinTheta * Math.cos(phi) * r;
      py = this.cameraWorldPos.y + cosTheta * r;
      pz = this.cameraWorldPos.z + sinTheta * Math.sin(phi) * r;
    }
    const petalIndex = this.petalData.length;
    const petal = {
      index: petalIndex, layerKey, renderLayerKey: cfg.renderLayer, matIndex, instanceIndex: -1,
      px, py, pz,
      rx: Math.random() * Math.PI * 2, ry: Math.random() * Math.PI * 2, rz: Math.random() * Math.PI * 2,
      scale,
      rotSpeedX: (Math.random() - 0.5) * 1.2,
      rotSpeedY: (Math.random() - 0.5) * 1.0,
      rotSpeedZ: (Math.random() - 0.5) * 0.6,
      fallSpeed: this.fallSpeed * (0.3 + Math.random() * 0.7) * (cfg.fallMult || 1.0),
      swayAmplitude: 0.6 + Math.random() * 1.5, swayFrequency: 0.4 + Math.random() * 0.9,
      swayPhase: Math.random() * Math.PI * 2,
      spiralRadius: 0.3 + Math.random() * 0.8, spiralSpeed: (Math.random() - 0.5) * 1.2,
      spiralPhase: Math.random() * Math.PI * 2,
      driftX: (Math.random() - 0.5) * 0.6, driftZ: (Math.random() - 0.5) * 0.5,
      dragFactor: 0.6 + Math.random() * 0.4,
      flipTimer: Math.random() * 2.5, flipCooldown: 1.2 + Math.random() * 2.5,
      isFlipping: false, flipEndTime: 0, gustResponse: 0.5 + Math.random() * 0.5,
      state: 'falling', restTimer: 0, restDuration: 0, slideSpeed: 0, originalFallSpeed: 0,
      // landing 过渡
      landingTimer: 0, landingDuration: 0, landingStartSpeed: 0,
      // resting 增强
      restTargetRx: 0, restTargetRz: 0, breathPhase: 0, flutterPhase: 0,
      // sliding 增强
      slideDriftDir: 0,
      needsRecycle: false,
    };
    petal.originalFallSpeed = petal.fallSpeed;
    this.petalData.push(petal);
    this.petalLayerMap[layerKey].push(petalIndex);
  }

  _recyclePetalData(petal) {
    const cfg = this.layerConfig[petal.layerKey];
    const radius = cfg.radiusMin + Math.random() * (cfg.radiusMax - cfg.radiusMin);
    // 球形上半球分布，花瓣从各个方向生成后往下飘落
    const phi = Math.random() * Math.PI * 2;
    const cosTheta = Math.random(); // [0,1] 上半球
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    const r = (0.5 + Math.random() * 0.5) * radius;
    petal.px = this.cameraWorldPos.x + sinTheta * Math.cos(phi) * r;
    petal.py = this.cameraWorldPos.y + cosTheta * r;
    petal.pz = this.cameraWorldPos.z + sinTheta * Math.sin(phi) * r;
    petal.rx = Math.random() * Math.PI * 2; petal.ry = Math.random() * Math.PI * 2; petal.rz = Math.random() * Math.PI * 2;
    petal.rotSpeedX = (Math.random() - 0.5) * 1.2;
    petal.rotSpeedY = (Math.random() - 0.5) * 1.0;
    petal.rotSpeedZ = (Math.random() - 0.5) * 0.6;
    petal.swayPhase = Math.random() * Math.PI * 2; petal.swayAmplitude = 0.6 + Math.random() * 1.5;
    petal.swayFrequency = 0.4 + Math.random() * 0.9; petal.spiralPhase = Math.random() * Math.PI * 2;
    petal.spiralSpeed = (Math.random() - 0.5) * 1.2;
    petal.driftX = (Math.random() - 0.5) * 0.6; petal.driftZ = (Math.random() - 0.5) * 0.5;
    // 重置 scale 到层级原始范围（碰撞时可能被放大过）
    petal.scale = cfg.scaleMin + Math.random() * (cfg.scaleMax - cfg.scaleMin);
    petal.fallSpeed = this.fallSpeed * (0.3 + Math.random() * 0.7) * (cfg.fallMult || 1.0);
    petal.originalFallSpeed = petal.fallSpeed;
    petal.flipTimer = 0.5 + Math.random() * 2; petal.gustResponse = 0.5 + Math.random() * 0.5;
    petal.state = 'falling'; petal.restTimer = 0; petal.slideSpeed = 0;
    petal.landingTimer = 0; petal.landingDuration = 0; petal.landingStartSpeed = 0;
    petal.restTargetRx = 0; petal.restTargetRz = 0; petal.slideDriftDir = 0;
  }

  /**
   * 生成涡流（由人物大动作触发）
   * @param {number} screenNX - 人物中心屏幕归一化 X (0~1)
   * @param {number} screenNY - 人物中心屏幕归一化 Y (0~1)
   * @param {number} intensity - 运动强度 (0~1)
   * @param {number} rotSign - 旋转方向 (-1 或 1)
   */
  spawnVortex(screenNX, screenNY, intensity, rotSign) {
    if (this._vortexCooldown > 0) return;
    if (this.vortices.length >= this._maxVortices) {
      // 移除最老的涡流
      this.vortices.shift();
    }
    
    // 将屏幕归一化坐标反投影到 3D 空间
    // 涡流位于 z ≈ 5~8 的位置（大约是中景花瓣的深度范围）
    const ndcX = screenNX * 2 - 1;
    const ndcY = -(screenNY * 2 - 1);
    const depth = 6.0; // 涡流在 3D 空间的深度
    
    // 用相机反投影得到世界坐标
    const worldPos = new THREE.Vector3(ndcX, ndcY, 0.5);
    worldPos.unproject(this.camera);
    // 从相机位置沿射线方向放置在 depth 距离
    const dir = worldPos.sub(this.camera.position).normalize();
    const vx = this.camera.position.x + dir.x * depth;
    const vy = this.camera.position.y + dir.y * depth;
    const vz = this.camera.position.z + dir.z * depth;
    
    const maxLife = 1.8 + intensity * 1.5; // 1.8~3.3 秒
    
    this.vortices.push({
      cx: vx, cy: vy, cz: vz,
      radius: 3.0 + intensity * 3.0,       // 有效半径 3~6
      maxRadius: 5.0 + intensity * 4.0,     // 扩散最大半径 5~9
      strength: 4.0 + intensity * 8.0,      // 切向力强度
      rotSign: rotSign,                      // 旋转方向
      life: maxLife,
      maxLife: maxLife,
      upForce: 0.6 + intensity * 1.0,       // 上升力（降低，避免花瓣停滞空中）
      rampUp: 0.2,                           // 启动延迟（秒）
    });
    
    this._vortexCooldown = 1.5; // 1.5 秒冷却（避免连续触发多个涡流）
  }

  /**
   * 更新涡流生命周期
   */
  _updateVortices(delta) {
    this._vortexCooldown = Math.max(0, this._vortexCooldown - delta);
    
    for (let i = this.vortices.length - 1; i >= 0; i--) {
      const v = this.vortices[i];
      v.life -= delta;
      if (v.life <= 0) {
        this.vortices.splice(i, 1);
        continue;
      }
      // 生命衰减比例
      const lifeRatio = v.life / v.maxLife;
      // 启动渐入
      const age = v.maxLife - v.life;
      const rampFactor = Math.min(1.0, age / v.rampUp);
      // 综合衰减（启动渐入 × 生命衰减）
      v._effectiveStrength = v.strength * rampFactor * lifeRatio * lifeRatio;
      v._effectiveUp = v.upForce * rampFactor * lifeRatio;
      // 半径随时间扩大
      v._currentRadius = v.radius + (v.maxRadius - v.radius) * (1 - lifeRatio);
    }
  }

  /**
   * 计算涡流对花瓣施加的力
   * @returns {{ fx, fy, fz, rotBoost }} 力和旋转加速
   */
  _calcVortexForce(px, py, pz) {
    let fx = 0, fy = 0, fz = 0, rotBoost = 0;
    
    for (const v of this.vortices) {
      const dx = px - v.cx;
      const dy = py - v.cy;
      const dz = pz - v.cz;
      const distSq = dx * dx + dy * dy + dz * dz;
      const r = v._currentRadius;
      
      if (distSq > r * r) continue;
      
      const dist = Math.sqrt(distSq) + 0.01;
      const strength = v._effectiveStrength;
      
      // 距离衰减：中心附近最强，边缘递减
      // 使用钟形曲线：peak 在 0.3r 处，避免中心奇点
      const normalDist = dist / r;
      const falloff = Math.exp(-((normalDist - 0.3) * (normalDist - 0.3)) / 0.18) * (1 - normalDist * normalDist);
      const effectiveFalloff = Math.max(0, falloff);
      
      // 切向力（XZ 平面上的旋转）
      // 方向：垂直于 (dx, dz) 方向
      const hDist = Math.sqrt(dx * dx + dz * dz) + 0.01;
      const tangentX = -dz / hDist * v.rotSign;
      const tangentZ = dx / hDist * v.rotSign;
      
      fx += tangentX * strength * effectiveFalloff;
      fz += tangentZ * strength * effectiveFalloff;
      
      // 弱向心力（微微拉向中心，防止飞散）
      const inwardStrength = strength * 0.15 * effectiveFalloff;
      fx -= (dx / dist) * inwardStrength;
      fz -= (dz / dist) * inwardStrength;
      
      // 上升力
      fy += v._effectiveUp * effectiveFalloff;
      
      // 旋转加速
      rotBoost += strength * effectiveFalloff * 0.5;
    }
    
    return { fx, fy, fz, rotBoost };
  }

  _rebuildAllInstanceMatrices() {
    // 按 renderLayer + matIndex 分组
    const assignment = {};
    for (const rk of ['far', 'mid', 'near']) {
      const meshes = this.renderMeshes[rk];
      if (!meshes) continue;
      for (let mi = 0; mi < meshes.length; mi++) assignment[`${rk}_${mi}`] = [];
    }
    for (let i = 0; i < this.petalData.length; i++) {
      const p = this.petalData[i];
      const key = `${p.renderLayerKey}_${p.matIndex}`;
      if (assignment[key]) { p.instanceIndex = assignment[key].length; assignment[key].push(i); }
    }
    for (const rk of ['far', 'mid', 'near']) {
      const meshes = this.renderMeshes[rk];
      if (!meshes) continue;
      for (let mi = 0; mi < meshes.length; mi++) {
        const list = assignment[`${rk}_${mi}`];
        const mesh = meshes[mi];
        if (!mesh || !list) continue;
        mesh.count = list.length;
        for (let j = 0; j < list.length; j++) {
          const p = this.petalData[list[j]];
          this._tempEuler.set(p.rx, p.ry, p.rz);
          this._tempQuaternion.setFromEuler(this._tempEuler);
          this._tempPosition.set(p.px, p.py, p.pz);
          this._tempScale.set(p.scale, p.scale, p.scale);
          this._tempMatrix.compose(this._tempPosition, this._tempQuaternion, this._tempScale);
          mesh.setMatrixAt(j, this._tempMatrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  setPetalCount(count) {
    if (!this.ready) { this.petalCount = count; return; }
    if (count === this.petalData.length) return;
    this.petalCount = count;
    this._createInstancedMeshes(count);
  }

  update(cameraData) {
    if (!this.ready || this.petalData.length === 0) return;
    if (this._contextLost) return;
    if (this.renderer) {
      const gl = this.renderer.getContext();
      if (gl && gl.isContextLost && gl.isContextLost()) {
        if (!this._contextLost) {
          this._contextLost = true;
          if (this._restoreTimer) clearTimeout(this._restoreTimer);
          this._restoreTimer = setTimeout(() => { if (this._contextLost) this._forceRecreateRenderer(); }, 2000);
        }
        return;
      }
    }

    const delta = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    // 风
    this.wind.time += delta;
    this.wind.turbulence = Math.sin(this.wind.time * 0.3) * 0.3 + Math.sin(this.wind.time * 0.7 + 1.5) * 0.2 +
      Math.sin(this.wind.time * 1.8 + 3.0) * 0.12 + Math.sin(this.wind.time * 3.5 + 5.0) * 0.06;

    this.gust.timer -= delta;
    if (this.gust.timer <= 0) {
      this.gust.active = true; this.gust.strength = 1.5 + Math.random() * 3.0;
      this.gust.direction = Math.random() * Math.PI * 2;
      this.gust.timer = this.gust.interval + Math.random() * 3; this.gust.interval = 2.5 + Math.random() * 4;
    }
    if (this.gust.active) { this.gust.strength *= 0.96; if (this.gust.strength < 0.1) this.gust.active = false; }
    const gustX = this.gust.active ? Math.cos(this.gust.direction) * this.gust.strength : 0;
    const gustZ = this.gust.active ? Math.sin(this.gust.direction) * this.gust.strength : 0;
    const now = performance.now();

    // === 涡流系统 ===
    // 检测大动作事件并生成涡流
    if (this.bodyCollision && this.bodyCollision.bigMotionEvent) {
      const evt = this.bodyCollision.bigMotionEvent;
      this.spawnVortex(evt.cx, evt.cy, evt.intensity, evt.rotSign);
      this.bodyCollision.bigMotionEvent = null; // 消费事件
    }
    // 更新涡流生命周期
    this._updateVortices(delta);
    const hasVortices = this.vortices.length > 0;

    // 相机
    if (cameraData) {
      if (cameraData.mode === 'gyroscope' && cameraData.quaternion) this.camera.quaternion.copy(cameraData.quaternion);
      else if (cameraData.rotation) { const rot = cameraData.rotation; this.camera.rotation.order = 'YXZ'; this.camera.rotation.set(-rot.x, -rot.y, rot.z); }
    }
    if (cameraData && cameraData.offset) {
      const off = cameraData.offset;
      this.camera.position.set(off.x, off.y, off.z);
      this.cameraWorldPos.x = off.x; this.cameraWorldPos.y = off.y; this.cameraWorldPos.z = off.z;
    }
    this.camera.updateMatrixWorld();

    const worldRadius = this.worldRadius;
    const windX = this.wind.x + this.wind.turbulence;
    const windZ = this.wind.z + this.wind.turbulence * 0.4;
    const camX = this.cameraWorldPos.x, camY = this.cameraWorldPos.y, camZ = this.cameraWorldPos.z;
    const gustActive = this.gust.active;
    const recycleDistSq = (worldRadius + 5) * (worldRadius + 5);

    // === 视锥体外回收：计算相机前方向量 ===
    // 获取相机世界空间前方向量（每帧只算一次）
    if (!this._camForward) this._camForward = new THREE.Vector3();
    this.camera.getWorldDirection(this._camForward);
    const fwdX = this._camForward.x, fwdY = this._camForward.y, fwdZ = this._camForward.z;
    // FOV 60° → 半角 30°，加 25° 余量 = 55°，cos(55°) ≈ 0.574
    // 对远景层更严格：cos(50°) ≈ 0.643
    const cosThresholdNear = 0.42;  // ~65° 近景宽松（用户可能在转头）
    const cosThresholdFar  = 0.57;  // ~55° 远景严格（反正看不清）
    const collisionActive = this.bodyCollision && this.bodyCollision.isActive;
    const screenW = window.innerWidth, screenH = window.innerHeight;
    const projCamera = this.camera;
    let restCount = 0;
    // 人物近距离标记：人很近时停靠花瓣应被释放
    const personTooClose = collisionActive && this.bodyCollision.estimatedDistance < 0.35;

    for (let i = 0; i < this.petalData.length; i++) {
      const p = this.petalData[i];

      // ===== landing 着陆过渡 =====
      if (p.state === 'landing') {
        // 人物突然靠近 → 释放停靠花瓣
        if (personTooClose) {
          p.state = 'falling'; p.fallSpeed = p.originalFallSpeed;
          continue;
        }
        restCount++;
        p.landingTimer += delta;
        const t = Math.min(p.landingTimer / p.landingDuration, 1.0);
        const ease = 1 - (1 - t) * (1 - t); // ease-out

        // 速度衰减
        p.fallSpeed = p.landingStartSpeed * (1 - ease);
        p.py -= p.fallSpeed * p.dragFactor * delta;

        // 微弹：sin 波在 t≈0.5 达到峰值
        p.py += Math.sin(t * Math.PI) * 0.012 * p.scale;

        // 旋转趋平（lerp 向贴合目标）
        p.rx += (p.restTargetRx - p.rx) * ease * 0.3;
        p.rz += (p.restTargetRz - p.rz) * ease * 0.3;
        p.rotSpeedX *= 0.90; p.rotSpeedY *= 0.92; p.rotSpeedZ *= 0.90;
        p.ry += p.rotSpeedY * delta;

        if (t >= 1.0) {
          p.state = 'resting'; p.fallSpeed = 0; p.restTimer = 0;
        }
        continue;
      }

      // ===== resting 停留（含呼吸感+翘边颤动+受风微扰） =====
      if (p.state === 'resting') {
        // 人物突然靠近 → 释放停靠花瓣
        if (personTooClose) {
          p.state = 'falling'; p.fallSpeed = p.originalFallSpeed;
          continue;
        }
        restCount++; p.restTimer += delta;

        // 呼吸感起伏
        p.py += Math.sin(elapsed * 0.8 + p.breathPhase) * 0.005 * delta;

        // 横向微晃
        p.px += Math.sin(elapsed * 1.5 + p.swayPhase) * 0.003;
        p.pz += Math.cos(elapsed * 1.1 + p.swayPhase) * 0.002;

        // 翘边颤动
        p.rx = p.restTargetRx + Math.sin(elapsed * 2.5 + p.flutterPhase) * 0.04;
        p.rz = p.restTargetRz + Math.cos(elapsed * 1.8 + p.flutterPhase) * 0.03;

        // y 轴缓慢旋转
        p.ry += 0.05 * delta;

        // 受风微扰
        p.px += windX * delta * 0.02;

        // 涡流可以把 resting 的花瓣吹起
        if (hasVortices) {
          const vForce = this._calcVortexForce(p.px, p.py, p.pz);
          if (Math.abs(vForce.fx) + Math.abs(vForce.fy) + Math.abs(vForce.fz) > 2.0) {
            p.state = 'falling';
            p.fallSpeed = p.originalFallSpeed * 0.3;
            p.rotSpeedX = (Math.random() - 0.5) * 2.0;
            p.rotSpeedY = (Math.random() - 0.5) * 1.5;
            continue;
          }
        }

        let shouldSlide = p.restTimer > p.restDuration;
        if (!shouldSlide && collisionActive) {
          this._projVec.set(p.px, p.py, p.pz); this._projVec.project(projCamera);
          const sx = (this._projVec.x * 0.5 + 0.5) * screenW, sy = (-this._projVec.y * 0.5 + 0.5) * screenH;
          if (!this.bodyCollision.isInsideBody(sx, sy)) shouldSlide = true;
        }
        if (shouldSlide) {
          p.state = 'sliding'; p.slideSpeed = p.originalFallSpeed * 0.15;
          p.slideDriftDir = (Math.random() > 0.5 ? 1 : -1) * (0.3 + Math.random() * 0.5);
        }
        continue;
      }

      // ===== sliding 滑落（侧翻+横向漂移+阵风再捕获） =====
      if (p.state === 'sliding') {
        p.slideSpeed += 6.0 * delta;
        p.py -= p.slideSpeed * delta;

        // 横向漂移
        p.px += p.slideDriftDir * delta;
        p.px += Math.sin(elapsed * 2 + p.swayPhase) * 0.015;

        // 侧翻旋转
        p.rx += p.rotSpeedX * 0.8 * delta;
        p.ry += p.rotSpeedY * 0.5 * delta;
        p.rz += p.slideDriftDir * 1.5 * delta;

        // 阵风再捕获：有小概率被风重新托起
        if (gustActive && Math.random() < 0.015) {
          p.state = 'falling'; p.fallSpeed = p.originalFallSpeed * 0.5;
          continue;
        }

        if (p.slideSpeed > p.originalFallSpeed * 1.5) { p.state = 'falling'; p.fallSpeed = p.originalFallSpeed; }
        const dx2 = p.px - camX, dy2 = p.py - camY, dz2 = p.pz - camZ;
        const slidDistSq = dx2*dx2 + dy2*dy2 + dz2*dz2;
        if (slidDistSq > recycleDistSq) { p.state = 'falling'; p.fallSpeed = p.originalFallSpeed; this._recyclePetalData(p); }
        // 滑落中的花瓣若在视野背后也回收
        else if (slidDistSq > 2.25) {
          const slidDist = Math.sqrt(slidDistSq);
          const cosA = (dx2 * fwdX + dy2 * fwdY + dz2 * fwdZ) / slidDist;
          if (cosA < 0) { p.state = 'falling'; p.fallSpeed = p.originalFallSpeed; this._recyclePetalData(p); }
        }
        continue;
      }

      // 飘落
      p.flipTimer -= delta;
      if (p.flipTimer <= 0 && !p.isFlipping) {
        p.isFlipping = true; p.flipEndTime = now + 500;
        const r = Math.random();
        if (r < 0.33) p.rotSpeedX += (Math.random() > 0.5 ? 1 : -1) * (1.0 + Math.random() * 1.5);
        else if (r < 0.66) p.rotSpeedY += (Math.random() > 0.5 ? 1 : -1) * (1.0 + Math.random() * 1.5);
        else p.rotSpeedZ += (Math.random() > 0.5 ? 1 : -1) * (1.0 + Math.random() * 1.5);
        p.flipTimer = p.flipCooldown + Math.random() * 3;
      }
      if (p.isFlipping && now > p.flipEndTime) p.isFlipping = false;

      p.rx += p.rotSpeedX * delta; p.ry += p.rotSpeedY * delta; p.rz += p.rotSpeedZ * delta;
      p.rotSpeedX *= 0.995; p.rotSpeedY *= 0.995; p.rotSpeedZ *= 0.997;
      if (Math.abs(p.rotSpeedX) < 0.1) p.rotSpeedX += (Math.random() - 0.5) * 0.05;
      if (Math.abs(p.rotSpeedY) < 0.1) p.rotSpeedY += (Math.random() - 0.5) * 0.04;

      const updraft = Math.sin(elapsed * 0.5 + p.swayPhase * 3) * 0.02;
      p.py -= (p.fallSpeed * p.dragFactor - updraft) * delta;
      const sway1 = Math.sin(elapsed * p.swayFrequency + p.swayPhase) * p.swayAmplitude;
      const sway2 = Math.sin(elapsed * p.swayFrequency * 0.37 + p.swayPhase + 2.0) * p.swayAmplitude * 0.4;
      const sway3 = Math.cos(elapsed * p.swayFrequency * 1.7 + p.swayPhase + 4.5) * p.swayAmplitude * 0.15;
      p.px += (sway1 + sway2 + sway3) * delta;
      p.pz += Math.sin(elapsed * p.swayFrequency * 0.6 + p.swayPhase + 1.0) * p.swayAmplitude * 0.5 * delta;
      const sa = elapsed * p.spiralSpeed + p.spiralPhase;
      p.px += Math.cos(sa) * p.spiralRadius * delta * 0.35; p.pz += Math.sin(sa) * p.spiralRadius * delta * 0.35;
      p.px += p.driftX * delta; p.pz += p.driftZ * delta;
      p.px += windX * delta * p.dragFactor; p.pz += windZ * delta * p.dragFactor;
      if (gustActive) {
        const gr = p.gustResponse * delta;
        p.px += gustX * gr; p.pz += gustZ * gr; p.py += this.gust.strength * 0.02 * gr;
        p.rotSpeedX += gustX * 0.15 * p.gustResponse; p.rotSpeedZ += gustZ * 0.1 * p.gustResponse;
      }
      // === 涡流受力（只影响中近景层） ===
      if (hasVortices && (p.layerKey === 'mid' || p.layerKey === 'midNear' || p.layerKey === 'near'
        || p.layerKey === 'midFar' || p.layerKey === 'veryNear')) {
        const vForce = this._calcVortexForce(p.px, p.py, p.pz);
        if (vForce.fx !== 0 || vForce.fy !== 0 || vForce.fz !== 0) {
          p.px += vForce.fx * delta;
          p.py += vForce.fy * delta;
          p.pz += vForce.fz * delta;
          // 涡流加速花瓣自转
          p.rotSpeedX += vForce.rotBoost * delta * (Math.random() - 0.5);
          p.rotSpeedY += vForce.rotBoost * delta * 0.8;
          p.rotSpeedZ += vForce.rotBoost * delta * (Math.random() - 0.5) * 0.5;
        }
      }
      const dx = p.px - camX, dy = p.py - camY, dz = p.pz - camZ;
      const distSqToCam = dx*dx + dy*dy + dz*dz;
      if (distSqToCam > recycleDistSq) { this._recyclePetalData(p); continue; }

      // === 视锥体外回收：脚下/背后的花瓣快速回收 ===
      // 只对距离 > 1.5 的花瓣做角度判定（太近的可能刚生成）
      if (distSqToCam > 2.25) {
        const distToCam = Math.sqrt(distSqToCam);
        // 花瓣方向与相机前方的 cos 夹角
        const cosAngle = (dx * fwdX + dy * fwdY + dz * fwdZ) / distToCam;
        // 远景层用严格阈值，近景层用宽松阈值
        const isFarLayer = (p.renderLayerKey === 'far');
        const threshold = isFarLayer ? cosThresholdFar : cosThresholdNear;
        // cosAngle < threshold 说明花瓣在视锥体外（夹角大于阈值角度）
        // cosAngle < 0 说明花瓣在相机背后
        if (cosAngle < threshold) {
          // 背后的花瓣直接回收
          if (cosAngle < 0) {
            this._recyclePetalData(p);
          } else {
            // 视野边缘外的花瓣：距离越远越快回收
            // 近处的给机会（用户转头可能看到），远处的直接回收
            const recycleDist = isFarLayer ? 5 : 8;
            if (distToCam > recycleDist) {
              this._recyclePetalData(p);
            }
          }
        }
      }

      // 碰撞（只对 mid/midNear/near 层，且停留上限 3 片）
      // 人物很近时（面积大、占满屏幕）禁用碰撞停靠，避免花瓣遮挡人脸
      const isCloseUp = collisionActive && this.bodyCollision.estimatedDistance < 0.35;
      const canCollide = collisionActive && !isCloseUp && projCamera && restCount < 3 &&
        (p.layerKey === 'mid' || p.layerKey === 'midNear' || p.layerKey === 'near');
      if (canCollide) {
        this._projVec.set(p.px, p.py, p.pz); this._projVec.project(projCamera);
        const sx = (this._projVec.x * 0.5 + 0.5) * screenW, sy = (-this._projVec.y * 0.5 + 0.5) * screenH;
        if (this._projVec.z > 0 && this._projVec.z < 1 && sx >= 0 && sx < screenW && sy >= 0 && sy < screenH) {
          const hit = this.bodyCollision.testPoint(sx, sy);
          if (hit.hit) {
            // 根据人物距离微调停靠花瓣大小：近处稍大，远处保持
            // scaleMult: 距离 0(很近) → 1.6×, 距离 0.5 → 1.3×, 距离 1(远) → 1.0×
            const dist = this.bodyCollision.estimatedDistance;
            const scaleMult = 1.0 + (1.0 - dist) * 0.6;
            p.scale = Math.min(p.scale * scaleMult, 1.2); // 上限 1.2 防止过大
            // 进入 landing 着陆过渡（而非直接 resting）
            p.state = 'landing';
            p.landingTimer = 0;
            p.landingDuration = 0.25 + Math.random() * 0.25; // 0.25~0.5s 过渡
            p.landingStartSpeed = p.fallSpeed;
            p.originalFallSpeed = p.fallSpeed;
            p.restTimer = 0;
            p.restDuration = 1.5 + Math.random() * 2.0;
            p.slideSpeed = 0;
            // 贴合目标姿态（不完全水平，有些许倾斜更自然）
            p.restTargetRx = (Math.random() - 0.5) * 0.3;
            p.restTargetRz = (Math.random() - 0.5) * 0.3;
            p.breathPhase = Math.random() * Math.PI * 2;
            p.flutterPhase = Math.random() * Math.PI * 2;
          }
        }
      }
    }
    this.restingCount = restCount;

    // 更新 InstancedMesh 矩阵
    this._updateInstanceMatrices();

    // ===== 3-pass 渲染：每 pass 只显示一个渲染层的 mesh =====
    if (this.renderer) {
      const webglCanvas = this.canvas;
      for (const renderKey of ['far', 'mid', 'near']) {
        // 显示/隐藏 mesh
        for (const rk of ['far', 'mid', 'near']) {
          const meshes = this.renderMeshes[rk];
          if (!meshes) continue;
          const vis = (rk === renderKey);
          for (const m of meshes) { if (m) m.visible = vis; }
        }
        // 显式清除 WebGL buffer，防止残影
        this.renderer.clear();
        // 渲染当前 pass
        this.renderer.render(this.scene, this.camera);
        // 立即同步复制到 2D canvas（在浏览器合成前完成读取）
        const layer = this.displayLayers[renderKey];
        if (layer && layer.ctx) {
          const dw = layer.canvas.width, dh = layer.canvas.height;
          layer.ctx.clearRect(0, 0, dw, dh);
          // 强制 flush WebGL 确保像素已就绪
          const gl = this.renderer.getContext();
          if (gl) gl.flush();
          layer.ctx.drawImage(webglCanvas, 0, 0, dw, dh);
        }
      }
    }

    // FPS
    this.frameCount++;
    if (now - this.lastFpsTime >= 1000) { this.fps = this.frameCount; this.frameCount = 0; this.lastFpsTime = now; }
  }

  _updateInstanceMatrices() {
    for (const rk of ['far', 'mid', 'near']) {
      const meshes = this.renderMeshes[rk];
      if (!meshes) continue;
      for (const mesh of meshes) { if (mesh) mesh.count = 0; }
    }
    for (let i = 0; i < this.petalData.length; i++) {
      const p = this.petalData[i];
      const meshes = this.renderMeshes[p.renderLayerKey];
      if (!meshes) continue;
      const mesh = meshes[p.matIndex];
      if (!mesh) continue;
      const idx = mesh.count;
      if (idx >= mesh.instanceMatrix.count) continue;
      this._tempEuler.set(p.rx, p.ry, p.rz);
      this._tempQuaternion.setFromEuler(this._tempEuler);
      this._tempPosition.set(p.px, p.py, p.pz);
      this._tempScale.set(p.scale, p.scale, p.scale);
      this._tempMatrix.compose(this._tempPosition, this._tempQuaternion, this._tempScale);
      mesh.setMatrixAt(idx, this._tempMatrix);
      mesh.count = idx + 1;
    }
    for (const rk of ['far', 'mid', 'near']) {
      const meshes = this.renderMeshes[rk];
      if (!meshes) continue;
      for (const mesh of meshes) { if (mesh && mesh.count > 0) mesh.instanceMatrix.needsUpdate = true; }
    }
  }

  _cleanupMeshes() {
    for (const rk of ['far', 'mid', 'near']) {
      const meshes = this.renderMeshes[rk];
      if (!meshes) continue;
      for (const mesh of meshes) { if (mesh && this.scene) { this.scene.remove(mesh); mesh.dispose(); } }
      this.renderMeshes[rk] = [];
    }
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    if (!this.renderer) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    const dpr = Math.min(window.devicePixelRatio, 2);
    for (const layer of Object.values(this.displayLayers)) {
      layer.canvas.width = w * dpr; layer.canvas.height = h * dpr;
    }
  }

  autoTunePerformance() {
    if (this.fps > 0 && this.fps < 15 && this.petalData.length > 500) {
      const reduction = Math.max(30, Math.floor(this.petalData.length * 0.08));
      this.setPetalCount(this.petalData.length - reduction);
    }
  }

  _forceRecreateRenderer() {
    try {
      if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
      for (const rk of ['far', 'mid', 'near']) {
        const meshes = this.renderMeshes[rk];
        if (!meshes) continue;
        for (const mesh of meshes) { if (mesh && this.scene) this.scene.remove(mesh); }
        this.renderMeshes[rk] = [];
      }
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, alpha: true, antialias: true, premultipliedAlpha: true,
        powerPreference: 'high-performance', preserveDrawingBuffer: false
      });
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.2;
      if (this.renderer.outputColorSpace !== undefined) this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      for (const mat of this.petalMaterials) { if (mat.map) mat.map.needsUpdate = true; mat.needsUpdate = true; }
      if (this.farPetalMaterials) {
        for (const mat of this.farPetalMaterials) { if (mat.map) mat.map.needsUpdate = true; mat.needsUpdate = true; }
      }
      for (const geo of this.petalGeometries) {
        if (geo.attributes.position) geo.attributes.position.needsUpdate = true;
        if (geo.attributes.normal) geo.attributes.normal.needsUpdate = true;
        if (geo.attributes.uv) geo.attributes.uv.needsUpdate = true;
        if (geo.index) geo.index.needsUpdate = true;
      }
      const numMaterials = this.petalMaterials.length;
      const layerCounts = { far: 0, mid: 0, near: 0 };
      for (const cfg of Object.values(this.layerConfig)) layerCounts[cfg.renderLayer] += Math.round(this.petalCount * cfg.ratio);
      for (const renderKey of ['far', 'mid', 'near']) {
        const count = layerCounts[renderKey];
        if (count === 0) continue;
        const perMat = Math.ceil(count / numMaterials) + 10;
        this.renderMeshes[renderKey] = [];
        for (let mi = 0; mi < numMaterials; mi++) {
          const geo = this.petalGeometries[mi % this.petalGeometries.length];
          const mats = (renderKey === 'far' && this.farPetalMaterials && this.farPetalMaterials.length > 0)
            ? this.farPetalMaterials : this.petalMaterials;
          const mesh = new THREE.InstancedMesh(geo, mats[mi], perMat);
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.frustumCulled = false; mesh.count = 0;
          this.scene.add(mesh); this.renderMeshes[renderKey].push(mesh);
        }
      }
      this._rebuildAllInstanceMatrices();
      this._contextLost = false;
      console.log('WebGL renderer 重建成功');
    } catch (err) {
      console.error('重建失败:', err);
      setTimeout(() => { if (this._contextLost || !this.renderer) this._forceRecreateRenderer(); }, 3000);
    }
  }

  destroy() {
    this._cleanupMeshes();
    if (this.renderer) this.renderer.dispose();
    this.petalGeometries.forEach(g => g.dispose());
    this.petalMaterials.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
    if (this.farPetalMaterials) this.farPetalMaterials.forEach(m => { m.dispose(); });
    this.petalData = [];
  }
}
