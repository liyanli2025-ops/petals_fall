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
      '1.png', '2.png', '3.png', '4.png',
      '5.png', '6.png', '7.png', '8.png'
    ];

    this.petalMaterials = [];
    this.petalGeometries = [];
    this.textureLoader = new THREE.TextureLoader();
    this.ready = false;

    // 8 个逻辑层，映射到 3 个渲染层
    this.layerConfig = {
      dust:     { ratio: 0.18, scaleMin: 0.05, scaleMax: 0.12, radiusMin: 16, radiusMax: 25, renderLayer: 'far',  fallMult: 0.7  },
      veryFar:  { ratio: 0.20, scaleMin: 0.10, scaleMax: 0.20, radiusMin: 12, radiusMax: 18, renderLayer: 'far',  fallMult: 0.8  },
      far:      { ratio: 0.16, scaleMin: 0.18, scaleMax: 0.35, radiusMin: 8,  radiusMax: 13, renderLayer: 'far',  fallMult: 0.9  },
      midFar:   { ratio: 0.12, scaleMin: 0.30, scaleMax: 0.50, radiusMin: 5,  radiusMax: 9,  renderLayer: 'mid',  fallMult: 1.0  },
      mid:      { ratio: 0.12, scaleMin: 0.40, scaleMax: 0.65, radiusMin: 3,  radiusMax: 6,  renderLayer: 'mid',  fallMult: 1.0  },
      midNear:  { ratio: 0.08, scaleMin: 0.50, scaleMax: 0.75, radiusMin: 2,  radiusMax: 4,  renderLayer: 'mid',  fallMult: 1.05 },
      near:     { ratio: 0.08, scaleMin: 0.55, scaleMax: 0.85, radiusMin: 1.5,radiusMax: 3.5,renderLayer: 'near', fallMult: 1.1  },
      veryNear: { ratio: 0.06, scaleMin: 0.80, scaleMax: 1.30, radiusMin: 0.8,radiusMax: 2.0,renderLayer: 'near', fallMult: 1.15 },
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
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true
      });
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // 3-pass 需要更低 DPR 保性能
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

  _loadPetalAssets() {
    const petalShapes = [
      { w: 0.50, h: 0.35, bendX: 0.12, bendY: 0.06, curl: 0.05, twist: 0.03 },
      { w: 0.44, h: 0.44, bendX: 0.15, bendY: 0.08, curl: 0.07, twist: 0.02 },
      { w: 0.36, h: 0.50, bendX: 0.18, bendY: 0.10, curl: 0.08, twist: 0.04 },
      { w: 0.40, h: 0.28, bendX: 0.10, bendY: 0.05, curl: 0.04, twist: 0.05 },
    ];
    petalShapes.forEach(cfg => {
      const geo = new THREE.PlaneGeometry(cfg.w, cfg.h, 12, 12);
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
      const mat = new THREE.MeshPhysicalMaterial({
        map: texture, side: THREE.DoubleSide, transparent: true, alphaTest: 0.05,
        opacity: 0.95, roughness: 0.55, metalness: 0.0, clearcoat: 0.08,
        clearcoatRoughness: 0.4, transmission: 0.2, thickness: 0.35, depthWrite: false,
      });
      this.petalMaterials.push(mat);
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

      for (let mi = 0; mi < numMaterials; mi++) {
        const geo = this.petalGeometries[mi % this.petalGeometries.length];
        const mesh = new THREE.InstancedMesh(geo, this.petalMaterials[mi], perMat);
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
        py = Math.abs(cluster.y) + Math.random() * 5;
        pz = cluster.z + (Math.random() - 0.5) * cluster.radius * 2;
        const dist = Math.sqrt(px * px + py * py + pz * pz);
        if (dist > this.worldRadius) { const s = this.worldRadius / dist * 0.9; px *= s; py = Math.abs(py * s); pz *= s; }
      } else {
        const phi = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * radius;
        px = Math.cos(phi) * r; py = Math.random() * radius; pz = Math.sin(phi) * r;
      }
    } else {
      const phi = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      px = this.cameraWorldPos.x + Math.cos(phi) * r;
      py = this.cameraWorldPos.y + (0.5 + Math.random() * 0.5) * radius;
      pz = this.cameraWorldPos.z + Math.sin(phi) * r;
    }
    const petalIndex = this.petalData.length;
    const petal = {
      index: petalIndex, layerKey, renderLayerKey: cfg.renderLayer, matIndex, instanceIndex: -1,
      px, py, pz,
      rx: Math.random() * Math.PI * 2, ry: Math.random() * Math.PI * 2, rz: Math.random() * Math.PI * 2,
      scale,
      rotSpeedX: (Math.random() - 0.5) * (1.8 / Math.max(scale, 0.3)),
      rotSpeedY: (Math.random() - 0.5) * (1.5 / Math.max(scale, 0.3)),
      rotSpeedZ: (Math.random() - 0.5) * (0.9 / Math.max(scale, 0.3)),
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
      needsRecycle: false,
    };
    petal.originalFallSpeed = petal.fallSpeed;
    this.petalData.push(petal);
    this.petalLayerMap[layerKey].push(petalIndex);
  }

  _recyclePetalData(petal) {
    const cfg = this.layerConfig[petal.layerKey];
    const radius = cfg.radiusMin + Math.random() * (cfg.radiusMax - cfg.radiusMin);
    const phi = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    petal.px = this.cameraWorldPos.x + Math.cos(phi) * r;
    petal.py = this.cameraWorldPos.y + (0.5 + Math.random() * 0.5) * radius;
    petal.pz = this.cameraWorldPos.z + Math.sin(phi) * r;
    petal.rx = Math.random() * Math.PI * 2; petal.ry = Math.random() * Math.PI * 2; petal.rz = Math.random() * Math.PI * 2;
    const s = petal.scale;
    petal.rotSpeedX = (Math.random() - 0.5) * (1.8 / Math.max(s, 0.3));
    petal.rotSpeedY = (Math.random() - 0.5) * (1.5 / Math.max(s, 0.3));
    petal.rotSpeedZ = (Math.random() - 0.5) * (0.9 / Math.max(s, 0.3));
    petal.swayPhase = Math.random() * Math.PI * 2; petal.swayAmplitude = 0.6 + Math.random() * 1.5;
    petal.swayFrequency = 0.4 + Math.random() * 0.9; petal.spiralPhase = Math.random() * Math.PI * 2;
    petal.spiralSpeed = (Math.random() - 0.5) * 1.2;
    petal.driftX = (Math.random() - 0.5) * 0.6; petal.driftZ = (Math.random() - 0.5) * 0.5;
    petal.fallSpeed = this.fallSpeed * (0.3 + Math.random() * 0.7) * (cfg.fallMult || 1.0);
    petal.originalFallSpeed = petal.fallSpeed;
    petal.flipTimer = 0.5 + Math.random() * 2; petal.gustResponse = 0.5 + Math.random() * 0.5;
    petal.state = 'falling'; petal.restTimer = 0; petal.slideSpeed = 0;
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
    const collisionActive = this.bodyCollision && this.bodyCollision.isActive;
    const screenW = window.innerWidth, screenH = window.innerHeight;
    const projCamera = this.camera;
    let restCount = 0;

    for (let i = 0; i < this.petalData.length; i++) {
      const p = this.petalData[i];

      if (p.state === 'resting') {
        restCount++; p.restTimer += delta;
        p.px += Math.sin(elapsed * 1.5 + p.swayPhase) * 0.003; p.ry += 0.05 * delta;
        let shouldSlide = p.restTimer > p.restDuration;
        if (!shouldSlide && collisionActive) {
          this._projVec.set(p.px, p.py, p.pz); this._projVec.project(projCamera);
          const sx = (this._projVec.x * 0.5 + 0.5) * screenW, sy = (-this._projVec.y * 0.5 + 0.5) * screenH;
          if (!this.bodyCollision.isInsideBody(sx, sy)) shouldSlide = true;
        }
        if (shouldSlide) { p.state = 'sliding'; p.slideSpeed = p.originalFallSpeed * 0.3; }
        continue;
      }
      if (p.state === 'sliding') {
        p.slideSpeed += 8.0 * delta; p.py -= p.slideSpeed * delta;
        p.px += Math.sin(elapsed * 2 + p.swayPhase) * 0.01;
        p.rx += p.rotSpeedX * 0.3 * delta; p.ry += p.rotSpeedY * 0.3 * delta;
        if (p.slideSpeed > p.originalFallSpeed * 1.5) { p.state = 'falling'; p.fallSpeed = p.originalFallSpeed; }
        const dx2 = p.px - camX, dy2 = p.py - camY, dz2 = p.pz - camZ;
        if (dx2*dx2 + dy2*dy2 + dz2*dz2 > recycleDistSq) { p.state = 'falling'; p.fallSpeed = p.originalFallSpeed; this._recyclePetalData(p); }
        continue;
      }

      // 飘落
      p.flipTimer -= delta;
      if (p.flipTimer <= 0 && !p.isFlipping) {
        p.isFlipping = true; p.flipEndTime = now + 500;
        const r = Math.random();
        if (r < 0.33) p.rotSpeedX += (Math.random() > 0.5 ? 1 : -1) * (2.5 + Math.random() * 3.5);
        else if (r < 0.66) p.rotSpeedY += (Math.random() > 0.5 ? 1 : -1) * (2.5 + Math.random() * 3.5);
        else p.rotSpeedZ += (Math.random() > 0.5 ? 1 : -1) * (2.5 + Math.random() * 3.5);
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
      const dx = p.px - camX, dy = p.py - camY, dz = p.pz - camZ;
      if (dx*dx + dy*dy + dz*dz > recycleDistSq) this._recyclePetalData(p);

      // 碰撞
      const canCollide = collisionActive && projCamera &&
        (p.layerKey === 'midFar' || p.layerKey === 'mid' || p.layerKey === 'midNear' || p.layerKey === 'near');
      if (canCollide) {
        this._projVec.set(p.px, p.py, p.pz); this._projVec.project(projCamera);
        const sx = (this._projVec.x * 0.5 + 0.5) * screenW, sy = (-this._projVec.y * 0.5 + 0.5) * screenH;
        if (this._projVec.z > 0 && this._projVec.z < 1 && sx >= 0 && sx < screenW && sy >= 0 && sy < screenH) {
          const hit = this.bodyCollision.testPoint(sx, sy);
          if (hit.hit) {
            p.state = 'resting'; p.restTimer = 0; p.restDuration = 3.0 + Math.random() * 3.0;
            p.originalFallSpeed = p.fallSpeed; p.fallSpeed = 0; p.slideSpeed = 0;
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
        // 渲染
        this.renderer.render(this.scene, this.camera);
        // 复制到 2D canvas
        const layer = this.displayLayers[renderKey];
        if (layer && layer.ctx) {
          const dw = layer.canvas.width, dh = layer.canvas.height;
          layer.ctx.clearRect(0, 0, dw, dh);
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
        canvas: this.canvas, alpha: true, antialias: true,
        powerPreference: 'high-performance', preserveDrawingBuffer: true
      });
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.2;
      if (this.renderer.outputColorSpace !== undefined) this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      for (const mat of this.petalMaterials) { if (mat.map) mat.map.needsUpdate = true; mat.needsUpdate = true; }
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
          const mesh = new THREE.InstancedMesh(geo, this.petalMaterials[mi], perMat);
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
    this.petalData = [];
  }
}
