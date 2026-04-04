/**
 * 花瓣粒子系统 v7 — 多层花瓣雨版
 * 
 * 架构：3 个 WebGL renderer（canvas-far/mid/near），5 个逻辑层
 *   - veryFar: 极远景（tiny，大量密集） → 渲染到 far canvas（CSS blur）
 *   - far:     远景                      → 渲染到 far canvas
 *   - mid:     中景（焦点清晰）          → 渲染到 mid canvas
 *   - near:    近景                      → 渲染到 near canvas（CSS blur）
 *   - veryNear:极近景（大朵虚化）        → 渲染到 near canvas
 * 
 * 花瓣从上方高处自然飘落，不会在视野中"无中生有"。
 */
class PetalParticleSystem {
  constructor() {
    // 三层 canvas + renderer（渲染层）
    this.layers = {
      far:  { canvas: document.getElementById('canvas-far'),  scene: null, camera: null, renderer: null },
      mid:  { canvas: document.getElementById('canvas-mid'),  scene: null, camera: null, renderer: null },
      near: { canvas: document.getElementById('canvas-near'), scene: null, camera: null, renderer: null },
    };

    this.petalCount = 1200;
    this.clock = new THREE.Clock();

    // 空间 — 球体分布，任何方向看都有花瓣
    this.worldRadius = 25;        // 球体半径
    this.fallSpeed = 3.5;

    // 风 — 温和的基础风 + 阵风系统
    this.wind = { x: 0.15, z: 0.1, turbulence: 0, time: 0 };
    this.gust = { active: false, strength: 0, direction: 0, timer: 0, interval: 3 + Math.random() * 4 };

    // 当前相机位置（用于让花瓣围绕相机重生）
    this.cameraWorldPos = { x: 0, y: 0, z: 0 };

    // 贴图
    this.petalTexturePaths = [
      '1.png', '2.png', '3.png', '4.png',
      '5.png', '6.png', '7.png', '8.png'
    ];

    this.petalMaterials = [];
    this.petalGeometries = [];
    this.textureLoader = new THREE.TextureLoader();
    this.ready = false;

    // 7 个逻辑层，映射到 3 个渲染层（renderer）
    // 远景层（70% 花瓣）：大量微小花瓣构成"花瓣雨"背景
    // 中景层（18%）：中等大小，清晰可辨
    // 近景层（12%）：少量大花瓣做前景虚化点缀
    this.layerConfig = {
      dust:     { ratio: 0.20, scaleMin: 0.05, scaleMax: 0.12, radiusMin: 16,  radiusMax: 25, renderLayer: 'far'  },
      veryFar:  { ratio: 0.22, scaleMin: 0.10, scaleMax: 0.20, radiusMin: 12,  radiusMax: 18, renderLayer: 'far'  },
      far:      { ratio: 0.18, scaleMin: 0.18, scaleMax: 0.35, radiusMin: 8,   radiusMax: 13, renderLayer: 'far'  },
      midFar:   { ratio: 0.12, scaleMin: 0.30, scaleMax: 0.50, radiusMin: 5,   radiusMax: 9,  renderLayer: 'mid'  },
      mid:      { ratio: 0.12, scaleMin: 0.40, scaleMax: 0.65, radiusMin: 3,   radiusMax: 6,  renderLayer: 'mid'  },
      near:     { ratio: 0.10, scaleMin: 0.55, scaleMax: 0.85, radiusMin: 1.5, radiusMax: 3.5,renderLayer: 'near' },
      veryNear: { ratio: 0.06, scaleMin: 0.80, scaleMax: 1.30, radiusMin: 0.8, radiusMax: 2.0,renderLayer: 'near' },
    };

    // 每个逻辑层单独存花瓣引用
    this.logicalPetals = {};
    for (const key of Object.keys(this.layerConfig)) {
      this.logicalPetals[key] = [];
    }

    this.fps = 0;
    this.frameCount = 0;
    this.lastFpsTime = 0;
  }

  get petals() {
    let all = [];
    for (const arr of Object.values(this.logicalPetals)) {
      all = all.concat(arr);
    }
    return all;
  }

  init() {
    // 初始化三层，带降级：如果创建多个 WebGL 上下文失败，降级为单 canvas
    this.degraded = false;
    let createdCount = 0;

    for (const [key, layer] of Object.entries(this.layers)) {
      layer.scene = new THREE.Scene();

      const aspect = window.innerWidth / window.innerHeight;
      layer.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
      layer.camera.position.set(0, 0, 0);

      try {
        layer.renderer = new THREE.WebGLRenderer({
          canvas: layer.canvas,
          alpha: true,
          antialias: key === 'mid',
          powerPreference: 'high-performance',
          preserveDrawingBuffer: true  // 拍照合成需要读取 canvas 内容
        });
        layer.renderer.setSize(window.innerWidth, window.innerHeight);
        layer.renderer.setPixelRatio(Math.min(window.devicePixelRatio, key === 'mid' ? 2 : 1.5));
        layer.renderer.setClearColor(0x000000, 0);
        layer.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        layer.renderer.toneMappingExposure = 1.2;
        if (layer.renderer.outputColorSpace !== undefined) {
          layer.renderer.outputColorSpace = THREE.SRGBColorSpace;
        }
        createdCount++;
      } catch (err) {
        console.warn(`WebGL 上下文创建失败 (${key}):`, err);
        layer.renderer = null;
      }

      // 光源
      const hemiLight = new THREE.HemisphereLight(0xfff5f0, 0xc8b0ff, 0.6);
      layer.scene.add(hemiLight);

      const mainLight = new THREE.DirectionalLight(0xfff0e0, 0.9);
      mainLight.position.set(5, 8, 3);
      layer.scene.add(mainLight);

      const fillLight = new THREE.DirectionalLight(0xe0e8ff, 0.35);
      fillLight.position.set(-3, -2, -5);
      layer.scene.add(fillLight);

      const backLight = new THREE.PointLight(0xffcccc, 0.4, 30);
      backLight.position.set(0, 5, -8);
      layer.scene.add(backLight);

      if (key === 'far') {
        layer.scene.fog = new THREE.FogExp2(0x000000, 0.02);
      }
    }

    // 如果有 renderer 创建失败，降级：把所有花瓣放到 mid 层
    if (createdCount < 3) {
      console.warn('多 WebGL 上下文不可用，降级为单层渲染');
      this.degraded = true;
      // 隐藏失败的 canvas
      for (const [key, layer] of Object.entries(this.layers)) {
        if (!layer.renderer && layer.canvas) {
          layer.canvas.style.display = 'none';
        }
      }
      // 把所有花瓣比例改到 mid 层
      if (this.layers.mid.renderer) {
        this.layerConfig = {
          dust:     { ratio: 0, scaleMin: 0, scaleMax: 0, radiusMin: 0, radiusMax: 0, renderLayer: 'far' },
          veryFar:  { ratio: 0, scaleMin: 0, scaleMax: 0, radiusMin: 0, radiusMax: 0, renderLayer: 'far' },
          far:      { ratio: 0, scaleMin: 0, scaleMax: 0, radiusMin: 0, radiusMax: 0, renderLayer: 'far' },
          midFar:   { ratio: 0, scaleMin: 0, scaleMax: 0, radiusMin: 0, radiusMax: 0, renderLayer: 'mid' },
          mid:      { ratio: 1.0, scaleMin: 0.08, scaleMax: 1.0, radiusMin: 1, radiusMax: 25, renderLayer: 'mid' },
          near:     { ratio: 0, scaleMin: 0, scaleMax: 0, radiusMin: 0, radiusMax: 0, renderLayer: 'near' },
          veryNear: { ratio: 0, scaleMin: 0, scaleMax: 0, radiusMin: 0, radiusMax: 0, renderLayer: 'near' },
        };
      }
    }

    this._loadPetalAssets();

    window.addEventListener('resize', () => this._onResize());

    return this;
  }

  _loadPetalAssets() {
    // 几何体 — 调大尺寸
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
        const x = pos.getX(i);
        const y = pos.getY(i);
        const nx = (x / cfg.w) + 0.5;
        const ny = (y / cfg.h) + 0.5;

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

    // 材质
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

      if (texture.colorSpace !== undefined) {
        texture.colorSpace = THREE.SRGBColorSpace;
      }
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;

      const mat = new THREE.MeshPhysicalMaterial({
        map: texture,
        side: THREE.DoubleSide,
        transparent: true,
        alphaTest: 0.05,
        opacity: 0.95,
        roughness: 0.6,
        metalness: 0.0,
        clearcoat: 0.08,
        clearcoatRoughness: 0.4,
        transmission: 0.1,
        thickness: 0.3,
        depthWrite: false,
      });

      this.petalMaterials.push(mat);
    });
  }

  _onAllTexturesLoaded() {
    console.log('花瓣贴图加载完成');
    this.ready = true;
    this._spawnAll(this.petalCount);
  }

  _spawnAll(totalCount) {
    for (const [key, cfg] of Object.entries(this.layerConfig)) {
      const count = Math.round(totalCount * cfg.ratio);
      for (let i = 0; i < count; i++) {
        this._spawnPetal(key, true);
      }
    }
  }

  _spawnPetal(layerKey, randomY = false) {
    if (this.petalMaterials.length === 0) return;

    const cfg = this.layerConfig[layerKey];
    if (!cfg || cfg.ratio === 0) return;

    const renderLayerKey = cfg.renderLayer;
    const layer = this.layers[renderLayerKey];
    if (!layer || !layer.renderer) return;

    const geoIndex = Math.floor(Math.random() * this.petalGeometries.length);
    const matIndex = Math.floor(Math.random() * this.petalMaterials.length);

    const mesh = new THREE.Mesh(this.petalGeometries[geoIndex], this.petalMaterials[matIndex]);

    const scale = cfg.scaleMin + Math.random() * (cfg.scaleMax - cfg.scaleMin);
    mesh.scale.set(scale, scale, scale);

    // 初始生成：randomY=true 时全球分布，false 时从上方生成
    const radius = cfg.radiusMin + Math.random() * (cfg.radiusMax - cfg.radiusMin);
    let px, py, pz;

    if (randomY) {
      // 初始化时全球均匀分布
      const cosTheta = 2 * Math.random() - 1;
      const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
      const phi = Math.random() * Math.PI * 2;
      px = sinTheta * Math.cos(phi) * radius;
      py = cosTheta * radius;
      pz = sinTheta * Math.sin(phi) * radius;
    } else {
      // 回收后从上方生成（上半球，偏上方）
      // cosTheta 范围 [0.3, 1.0] → 只在上方区域生成，不会从视线侧面/下方冒出
      const cosTheta = 0.3 + Math.random() * 0.7;
      const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
      const phi = Math.random() * Math.PI * 2;
      px = this.cameraWorldPos.x + sinTheta * Math.cos(phi) * radius;
      py = this.cameraWorldPos.y + cosTheta * radius;
      pz = this.cameraWorldPos.z + sinTheta * Math.sin(phi) * radius;
    }

    mesh.position.set(px, py, pz);

    mesh.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2
    );

    mesh.userData = {
      layerKey: layerKey,
      renderLayerKey: renderLayerKey,
      rotSpeed: {
        x: (Math.random() - 0.5) * (1.8 / Math.max(scale, 0.5)),
        y: (Math.random() - 0.5) * (1.5 / Math.max(scale, 0.5)),
        z: (Math.random() - 0.5) * (0.9 / Math.max(scale, 0.5)),
      },
      fallSpeed: this.fallSpeed * (0.3 + Math.random() * 0.7),
      sway: {
        amplitude: 0.6 + Math.random() * 1.5,
        frequency: 0.4 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
      },
      spiral: {
        radius: 0.3 + Math.random() * 0.8,
        speed: (Math.random() - 0.5) * 1.2,
        phase: Math.random() * Math.PI * 2,
      },
      drift: {
        x: (Math.random() - 0.5) * 0.6,
        z: (Math.random() - 0.5) * 0.5,
      },
      dragFactor: 0.4 + Math.random() * 0.6,
      flipTimer: Math.random() * 2.5,
      flipCooldown: 1.2 + Math.random() * 2.5,
      isFlipping: false,
      gustResponse: 0.5 + Math.random() * 0.5,
    };

    layer.scene.add(mesh);
    this.logicalPetals[layerKey].push(mesh);
  }

  setPetalCount(count) {
    if (!this.ready) {
      this.petalCount = count;
      return;
    }

    const currentTotal = this.petals.length;
    const diff = count - currentTotal;

    if (diff > 0) {
      for (const [key, cfg] of Object.entries(this.layerConfig)) {
        const layerAdd = Math.round(diff * cfg.ratio);
        for (let i = 0; i < layerAdd; i++) this._spawnPetal(key, true);
      }
    } else if (diff < 0) {
      let toRemove = -diff;
      for (const [key, cfg] of Object.entries(this.layerConfig)) {
        const arr = this.logicalPetals[key];
        const renderLayer = this.layers[cfg.renderLayer];
        const layerRemove = Math.min(
          Math.round(toRemove * cfg.ratio),
          arr.length - 2
        );
        for (let i = 0; i < layerRemove && arr.length > 2; i++) {
          const p = arr.pop();
          if (p && renderLayer) renderLayer.scene.remove(p);
          toRemove--;
        }
        if (toRemove <= 0) break;
      }
    }
    this.petalCount = count;
  }

  update(cameraData) {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    // 风力 — 更丰富的湍流 + 阵风系统
    this.wind.time += delta;
    this.wind.turbulence =
      Math.sin(this.wind.time * 0.3) * 0.3 +
      Math.sin(this.wind.time * 0.7 + 1.5) * 0.2 +
      Math.sin(this.wind.time * 1.8 + 3.0) * 0.12 +
      Math.sin(this.wind.time * 3.5 + 5.0) * 0.06;

    // 阵风
    this.gust.timer -= delta;
    if (this.gust.timer <= 0) {
      this.gust.active = true;
      this.gust.strength = 1.5 + Math.random() * 3.0;
      this.gust.direction = Math.random() * Math.PI * 2;
      this.gust.timer = this.gust.interval + Math.random() * 3;
      this.gust.interval = 2.5 + Math.random() * 4;
    }
    if (this.gust.active) {
      this.gust.strength *= 0.96;
      if (this.gust.strength < 0.1) this.gust.active = false;
    }

    const gustX = this.gust.active ? Math.cos(this.gust.direction) * this.gust.strength : 0;
    const gustZ = this.gust.active ? Math.sin(this.gust.direction) * this.gust.strength : 0;

    // 按逻辑层更新花瓣
    for (const [logKey, cfg] of Object.entries(this.layerConfig)) {
      const arr = this.logicalPetals[logKey];
      if (!arr) continue;
      const renderLayer = this.layers[cfg.renderLayer];
      if (!renderLayer || !renderLayer.renderer) continue;

      for (let i = arr.length - 1; i >= 0; i--) {
        const petal = arr[i];
        const ud = petal.userData;

        // 间歇翻转
        ud.flipTimer -= delta;
        if (ud.flipTimer <= 0 && !ud.isFlipping) {
          ud.isFlipping = true;
          const flipAxis = ['x', 'y', 'z'][Math.floor(Math.random() * 3)];
          ud.rotSpeed[flipAxis] += (Math.random() > 0.5 ? 1 : -1) * (2.5 + Math.random() * 3.5);
          ud.flipTimer = ud.flipCooldown + Math.random() * 3;
          setTimeout(() => { ud.isFlipping = false; }, 500);
        }

        petal.rotation.x += ud.rotSpeed.x * delta;
        petal.rotation.y += ud.rotSpeed.y * delta;
        petal.rotation.z += ud.rotSpeed.z * delta;

        ud.rotSpeed.x *= 0.995;
        ud.rotSpeed.y *= 0.995;
        ud.rotSpeed.z *= 0.997;
        if (Math.abs(ud.rotSpeed.x) < 0.1) ud.rotSpeed.x += (Math.random() - 0.5) * 0.05;
        if (Math.abs(ud.rotSpeed.y) < 0.1) ud.rotSpeed.y += (Math.random() - 0.5) * 0.04;

        // 下落
        const updraft = Math.sin(elapsed * 0.5 + ud.sway.phase * 3) * 0.05;
        petal.position.y -= (ud.fallSpeed * ud.dragFactor - updraft) * delta;

        // 摇摆
        const sway1 = Math.sin(elapsed * ud.sway.frequency + ud.sway.phase) * ud.sway.amplitude;
        const sway2 = Math.sin(elapsed * ud.sway.frequency * 0.37 + ud.sway.phase + 2.0) * ud.sway.amplitude * 0.4;
        const sway3 = Math.cos(elapsed * ud.sway.frequency * 1.7 + ud.sway.phase + 4.5) * ud.sway.amplitude * 0.15;
        petal.position.x += (sway1 + sway2 + sway3) * delta;

        const swayZ = Math.sin(elapsed * ud.sway.frequency * 0.6 + ud.sway.phase + 1.0) * ud.sway.amplitude * 0.5;
        petal.position.z += swayZ * delta;

        // 螺旋
        const sa = elapsed * ud.spiral.speed + ud.spiral.phase;
        petal.position.x += Math.cos(sa) * ud.spiral.radius * delta * 0.35;
        petal.position.z += Math.sin(sa) * ud.spiral.radius * delta * 0.35;

        // 横向漂移
        petal.position.x += ud.drift.x * delta;
        petal.position.z += ud.drift.z * delta;

        // 基础风
        petal.position.x += (this.wind.x + this.wind.turbulence) * delta * ud.dragFactor;
        petal.position.z += (this.wind.z + this.wind.turbulence * 0.4) * delta * ud.dragFactor;

        // 阵风
        if (this.gust.active) {
          const gr = ud.gustResponse * delta;
          petal.position.x += gustX * gr;
          petal.position.z += gustZ * gr;
          petal.position.y += this.gust.strength * 0.02 * gr;
          ud.rotSpeed.x += gustX * 0.15 * ud.gustResponse;
          ud.rotSpeed.z += gustZ * 0.1 * ud.gustResponse;
        }

        // 回收 — 超出球体范围就回收（从上方重生）
        const dx = petal.position.x - this.cameraWorldPos.x;
        const dy = petal.position.y - this.cameraWorldPos.y;
        const dz = petal.position.z - this.cameraWorldPos.z;
        const distFromCamera = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distFromCamera > this.worldRadius + 5) {
          this._recyclePetal(petal, logKey);
        }
      }
    }

    // 相机控制 + 渲染（3 个 renderer）
    for (const [key, layer] of Object.entries(this.layers)) {
      if (!layer.renderer) continue;

      // 相机旋转
      if (cameraData) {
        if (cameraData.mode === 'gyroscope' && cameraData.quaternion) {
          layer.camera.quaternion.copy(cameraData.quaternion);
        } else if (cameraData.rotation) {
          const rot = cameraData.rotation;
          layer.camera.rotation.order = 'YXZ';
          layer.camera.rotation.set(-rot.x, -rot.y, rot.z);
        }
      }

      // 相机平移
      if (cameraData && cameraData.offset) {
        const off = cameraData.offset;
        layer.camera.position.set(off.x, off.y, off.z);
        this.cameraWorldPos.x = off.x;
        this.cameraWorldPos.y = off.y;
        this.cameraWorldPos.z = off.z;
      }

      layer.renderer.render(layer.scene, layer.camera);
    }

    // FPS
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsTime = now;
    }
  }

  _recyclePetal(petal, logicalLayerKey) {
    const cfg = this.layerConfig[logicalLayerKey];

    // 从上方重生：cosTheta [0.3, 1.0] → 只在上半球偏上区域
    // 花瓣从高处自然飘落进入视野，不会"无中生有"
    const radius = cfg.radiusMin + Math.random() * (cfg.radiusMax - cfg.radiusMin);
    const cosTheta = 0.3 + Math.random() * 0.7; // 偏上方
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    const phi = Math.random() * Math.PI * 2;

    petal.position.set(
      this.cameraWorldPos.x + sinTheta * Math.cos(phi) * radius,
      this.cameraWorldPos.y + cosTheta * radius,
      this.cameraWorldPos.z + sinTheta * Math.sin(phi) * radius
    );

    petal.material = this.petalMaterials[Math.floor(Math.random() * this.petalMaterials.length)];
    petal.geometry = this.petalGeometries[Math.floor(Math.random() * this.petalGeometries.length)];

    const ud = petal.userData;
    const s = petal.scale.x;
    ud.rotSpeed.x = (Math.random() - 0.5) * (1.8 / Math.max(s, 0.5));
    ud.rotSpeed.y = (Math.random() - 0.5) * (1.5 / Math.max(s, 0.5));
    ud.rotSpeed.z = (Math.random() - 0.5) * (0.9 / Math.max(s, 0.5));
    ud.sway.phase = Math.random() * Math.PI * 2;
    ud.sway.amplitude = 0.6 + Math.random() * 1.5;
    ud.sway.frequency = 0.4 + Math.random() * 0.9;
    ud.spiral.phase = Math.random() * Math.PI * 2;
    ud.spiral.speed = (Math.random() - 0.5) * 1.2;
    ud.drift.x = (Math.random() - 0.5) * 0.6;
    ud.drift.z = (Math.random() - 0.5) * 0.5;
    ud.fallSpeed = this.fallSpeed * (0.3 + Math.random() * 0.7);
    ud.flipTimer = 0.5 + Math.random() * 2;
    ud.gustResponse = 0.5 + Math.random() * 0.5;

    petal.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2
    );
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const layer of Object.values(this.layers)) {
      if (!layer.renderer) continue;
      layer.camera.aspect = w / h;
      layer.camera.updateProjectionMatrix();
      layer.renderer.setSize(w, h);
    }
  }

  autoTunePerformance() {
    if (this.fps > 0 && this.fps < 22 && this.petals.length > 100) {
      const reduction = Math.max(20, Math.floor(this.petals.length * 0.1));
      this.setPetalCount(this.petals.length - reduction);
      console.log(`性能优化：花瓣数降至 ${this.petals.length}`);
    }
  }

  destroy() {
    for (const layer of Object.values(this.layers)) {
      if (layer.renderer) layer.renderer.dispose();
    }
    for (const [key, arr] of Object.entries(this.logicalPetals)) {
      const renderKey = this.layerConfig[key] ? this.layerConfig[key].renderLayer : null;
      const layer = renderKey ? this.layers[renderKey] : null;
      arr.forEach(p => { if (layer) layer.scene.remove(p); });
      this.logicalPetals[key] = [];
    }
    this.petalGeometries.forEach(g => g.dispose());
    this.petalMaterials.forEach(m => {
      if (m.map) m.map.dispose();
      m.dispose();
    });
  }
}
