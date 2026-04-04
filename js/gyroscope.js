/**
 * 陀螺仪 / 加速度计 / 鼠标交互控制模块
 * 
 * 使用四元数方案，彻底解决欧拉角万向锁问题。
 * 输出：
 *   - quaternion (THREE.Quaternion) — 相机旋转（相对于校准姿态）
 *   - linearOffset { x, y, z }     — 相机平移
 *   - smoothRotation { x, y, z }   — 鼠标模式的欧拉角fallback
 */
class GyroscopeManager {
  constructor() {
    this.orientation = { alpha: 0, beta: 0, gamma: 0 };
    this.smoothRotation = { x: 0, y: 0, z: 0 };
    this.targetRotation = { x: 0, y: 0, z: 0 };
    this.smoothFactor = 0.15;
    this.mode = 'none';
    this.gyroAvailable = false;
    this.mousePos = { x: 0, y: 0 };
    this.isCalibrated = false;

    // 四元数方案
    this.calibrationQuat = null;       // 校准时的初始四元数（逆）
    this.currentQuat = new THREE.Quaternion();
    this.smoothQuat = new THREE.Quaternion();  // 平滑后的四元数
    this.quatSmoothFactor = 0.15;

    // 加速度计 → 线性平移
    this.linearOffset = { x: 0, y: 0, z: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.lastMotionTime = 0;
    this.filteredAcc = { x: 0, y: 0, z: 0 };
    this.motionScale = 0.003;
    this.velocityDamping = 0.92;
    this.offsetDamping = 0.985;
    this.accThreshold = 0.4;

    this._onDeviceOrientation = this._onDeviceOrientation.bind(this);
    this._onDeviceMotion = this._onDeviceMotion.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
  }

  /**
   * 用外部权限结果初始化（推荐，iOS Safari 兼容）
   */
  async initWithPermission(permissionGranted) {
    if (permissionGranted && window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', this._onDeviceOrientation, true);

      const hasData = await new Promise((resolve) => {
        let received = false;
        const check = (e) => {
          if (e.alpha !== null || e.beta !== null || e.gamma !== null) {
            received = true;
          }
        };
        window.addEventListener('deviceorientation', check);
        setTimeout(() => {
          window.removeEventListener('deviceorientation', check);
          resolve(received);
        }, 500);
      });

      if (hasData) {
        this.gyroAvailable = true;
        this.mode = 'gyroscope';
        // 同时启动加速度计
        this._initMotion();
        console.log('交互模式：陀螺仪 + 加速度计');
        return this.mode;
      } else {
        window.removeEventListener('deviceorientation', this._onDeviceOrientation, true);
      }
    }

    this._initMouseControl();
    this.mode = 'mouse';
    console.log('交互模式：鼠标/触摸');
    return this.mode;
  }

  /**
   * 传统初始化方式
   */
  async init() {
    const gyroOk = await this._initGyroscope();
    if (gyroOk) {
      this.mode = 'gyroscope';
      this._initMotion();
      console.log('交互模式：陀螺仪 + 加速度计');
    } else {
      this._initMouseControl();
      this.mode = 'mouse';
      console.log('交互模式：鼠标/触摸');
    }
    return this.mode;
  }

  async _initGyroscope() {
    if (!window.DeviceOrientationEvent) return false;

    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') return false;
      } catch (err) {
        console.warn('请求陀螺仪权限失败:', err);
        return false;
      }
    }

    window.addEventListener('deviceorientation', this._onDeviceOrientation, true);

    return new Promise((resolve) => {
      let received = false;
      const check = (e) => {
        if (e.alpha !== null || e.beta !== null || e.gamma !== null) {
          received = true;
        }
      };
      window.addEventListener('deviceorientation', check);
      setTimeout(() => {
        window.removeEventListener('deviceorientation', check);
        this.gyroAvailable = received;
        if (!received) {
          window.removeEventListener('deviceorientation', this._onDeviceOrientation, true);
        }
        resolve(received);
      }, 500);
    });
  }

  /**
   * 初始化加速度计（DeviceMotion）
   */
  _initMotion() {
    this.lastMotionTime = performance.now();
    window.addEventListener('devicemotion', this._onDeviceMotion, true);
  }

  _initMouseControl() {
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('touchmove', this._onTouchMove, { passive: true });
  }

  /**
   * 从 DeviceOrientation 的 alpha/beta/gamma 构建设备四元数
   * 标准算法：ZXY 内旋 + 屏幕朝向补偿
   * 参考：W3C DeviceOrientation spec / Three.js DeviceOrientationControls
   */
  _deviceOrientationToQuaternion(alpha, beta, gamma) {
    const degToRad = Math.PI / 180;
    const a = alpha * degToRad; // Z 轴
    const b = beta * degToRad;  // X' 轴
    const g = gamma * degToRad; // Y'' 轴

    // ZXY 内旋四元数
    const c1 = Math.cos(b / 2);
    const s1 = Math.sin(b / 2);
    const c2 = Math.cos(g / 2);
    const s2 = Math.sin(g / 2);
    const c3 = Math.cos(a / 2);
    const s3 = Math.sin(a / 2);

    const q = new THREE.Quaternion();
    q.set(
      s1 * c2 * c3 - c1 * s2 * s3,
      c1 * s2 * c3 + s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3
    );

    // 补偿手机坐标系到 WebGL 坐标系：
    // 手机竖直时 beta≈90°，需要绕 X 轴旋转 -90° 让 "前方" 对齐屏幕法线
    const screenAdjust = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° around X
    q.multiply(screenAdjust);

    // 屏幕方向补偿（如横屏时）
    const screenOrientation = (window.screen.orientation || {}).angle || window.orientation || 0;
    const orient = new THREE.Quaternion();
    orient.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -screenOrientation * degToRad);
    q.multiply(orient);

    return q;
  }

  _onDeviceOrientation(e) {
    if (e.alpha === null && e.beta === null && e.gamma === null) return;

    const alpha = e.alpha || 0;
    const beta = e.beta || 0;
    const gamma = e.gamma || 0;

    // 构建当前设备四元数（绝对方向）
    const qCurrent = this._deviceOrientationToQuaternion(alpha, beta, gamma);

    // 直接使用绝对四元数，不做相对校准
    // 这样相机的世界坐标系和花瓣的世界坐标系一致
    // 花瓣沿世界 -Y 飘落 = 永远朝重力方向
    this.currentQuat.copy(qCurrent);
  }

  /**
   * 加速度计事件 → 积分得到速度 → 积分得到位移
   */
  _onDeviceMotion(e) {
    // 优先用不含重力的纯线性加速度
    const acc = e.acceleration || e.accelerationIncludingGravity;
    if (!acc || (acc.x === null && acc.y === null && acc.z === null)) return;

    const now = performance.now();
    const dt = Math.min((now - this.lastMotionTime) / 1000, 0.05);
    this.lastMotionTime = now;

    if (dt <= 0) return;

    const ax = acc.x || 0;
    const ay = acc.y || 0;
    const az = acc.z || 0;

    // 低通滤波（平滑噪声）
    const lp = 0.3;
    this.filteredAcc.x += (ax - this.filteredAcc.x) * lp;
    this.filteredAcc.y += (ay - this.filteredAcc.y) * lp;
    this.filteredAcc.z += (az - this.filteredAcc.z) * lp;

    // 阈值过滤（小于阈值的认为是静止噪声）
    const fx = Math.abs(this.filteredAcc.x) > this.accThreshold ? this.filteredAcc.x : 0;
    const fy = Math.abs(this.filteredAcc.y) > this.accThreshold ? this.filteredAcc.y : 0;
    const fz = Math.abs(this.filteredAcc.z) > this.accThreshold ? this.filteredAcc.z : 0;

    // 积分加速度 → 速度
    this.velocity.x += fx * dt;
    this.velocity.y += fy * dt;
    this.velocity.z += fz * dt;

    // 速度衰减（手机停下后速度归零）
    this.velocity.x *= this.velocityDamping;
    this.velocity.y *= this.velocityDamping;
    this.velocity.z *= this.velocityDamping;

    // 积分速度 → 位移
    this.linearOffset.x += this.velocity.x * dt * this.motionScale;
    this.linearOffset.y += this.velocity.y * dt * this.motionScale;
    this.linearOffset.z += this.velocity.z * dt * this.motionScale;

    // 偏移回弹（缓慢归零，防止漂移）
    this.linearOffset.x *= this.offsetDamping;
    this.linearOffset.y *= this.offsetDamping;
    this.linearOffset.z *= this.offsetDamping;

    // 限制最大偏移量（防止飞出花瓣范围）
    const maxOffset = 2.0;
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    this.linearOffset.x = clamp(this.linearOffset.x, -maxOffset, maxOffset);
    this.linearOffset.y = clamp(this.linearOffset.y, -maxOffset, maxOffset);
    this.linearOffset.z = clamp(this.linearOffset.z, -maxOffset, maxOffset);
  }

  _onMouseMove(e) {
    this.mousePos.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mousePos.y = (e.clientY / window.innerHeight) * 2 - 1;
    this.targetRotation.y = this.mousePos.x * Math.PI * 0.5;
    this.targetRotation.x = this.mousePos.y * Math.PI * 0.25;
  }

  _onTouchMove(e) {
    if (e.touches.length > 0) {
      const touch = e.touches[0];
      this.mousePos.x = (touch.clientX / window.innerWidth) * 2 - 1;
      this.mousePos.y = (touch.clientY / window.innerHeight) * 2 - 1;
      this.targetRotation.y = this.mousePos.x * Math.PI * 0.5;
      this.targetRotation.x = this.mousePos.y * Math.PI * 0.25;
    }
  }

  update() {
    // 鼠标模式用欧拉角平滑
    this.smoothRotation.x += (this.targetRotation.x - this.smoothRotation.x) * this.smoothFactor;
    this.smoothRotation.y += (this.targetRotation.y - this.smoothRotation.y) * this.smoothFactor;
    this.smoothRotation.z += (this.targetRotation.z - this.smoothRotation.z) * this.smoothFactor;

    // 陀螺仪模式用四元数 slerp 平滑
    if (this.mode === 'gyroscope') {
      this.smoothQuat.slerp(this.currentQuat, this.quatSmoothFactor);
    }
  }

  /**
   * 获取完整的相机控制数据
   */
  getCameraData() {
    return {
      rotation: this.smoothRotation,     // 鼠标模式用
      quaternion: this.smoothQuat,        // 陀螺仪模式用
      offset: this.linearOffset,
      mode: this.mode
    };
  }

  recalibrate() {
    this.isCalibrated = false;
    this.calibrationQuat = null;
    this.smoothQuat.identity();
    this.currentQuat.identity();
    this.linearOffset = { x: 0, y: 0, z: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.filteredAcc = { x: 0, y: 0, z: 0 };
  }

  destroy() {
    window.removeEventListener('deviceorientation', this._onDeviceOrientation, true);
    window.removeEventListener('devicemotion', this._onDeviceMotion, true);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('touchmove', this._onTouchMove);
  }
}
