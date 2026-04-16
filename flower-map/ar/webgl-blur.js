/**
 * WebGL 高斯模糊后处理器
 * 使用两 pass 分离式高斯模糊（水平 + 垂直），在 GPU 上运行
 * 用于替代 Canvas 2D ctx.filter（iOS Safari 不支持）的降级方案
 */
class WebGLBlurRenderer {
  constructor() {
    this._canvas = document.createElement('canvas');
    this._gl = null;
    this._program = null;
    this._fb = null;       // framebuffer for ping-pong
    this._texInput = null;
    this._texPing = null;
    this._vao = null;
    this._ready = false;
    this._init();
  }

  _init() {
    const gl = this._canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    }) || this._canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });

    if (!gl) {
      console.warn('[WebGLBlur] WebGL 不可用');
      return;
    }
    this._gl = gl;
    this._isWebGL2 = gl instanceof WebGL2RenderingContext;

    // 顶点着色器：全屏三角形
    const vsSource = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    // 片段着色器：9-tap 高斯模糊（分离式，方向由 u_dir 控制）
    const fsSource = `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_tex;
      uniform vec2 u_dir;       // (1/w, 0) 或 (0, 1/h) × blurRadius
      
      void main() {
        // 9-tap 高斯权重（sigma ≈ 2.4，对应约 5px CSS blur 效果）
        // 权重: [0.0162, 0.0540, 0.1216, 0.1836, 0.2492, 0.1836, 0.1216, 0.0540, 0.0162]
        // 对称优化为 5 次采样
        vec4 color = vec4(0.0);
        color += texture2D(u_tex, v_uv - 4.0 * u_dir) * 0.0162;
        color += texture2D(u_tex, v_uv - 3.0 * u_dir) * 0.0540;
        color += texture2D(u_tex, v_uv - 2.0 * u_dir) * 0.1216;
        color += texture2D(u_tex, v_uv - 1.0 * u_dir) * 0.1836;
        color += texture2D(u_tex, v_uv)                * 0.2492;
        color += texture2D(u_tex, v_uv + 1.0 * u_dir) * 0.1836;
        color += texture2D(u_tex, v_uv + 2.0 * u_dir) * 0.1216;
        color += texture2D(u_tex, v_uv + 3.0 * u_dir) * 0.0540;
        color += texture2D(u_tex, v_uv + 4.0 * u_dir) * 0.0162;
        gl_FragColor = color;
      }
    `;

    const vs = this._compileShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = this._compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[WebGLBlur] 链接失败:', gl.getProgramInfoLog(prog));
      return;
    }
    this._program = prog;
    this._uTex = gl.getUniformLocation(prog, 'u_tex');
    this._uDir = gl.getUniformLocation(prog, 'u_dir');

    // 全屏四边形（两个三角形）
    const verts = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // 创建纹理和 framebuffer
    this._texInput = this._createTexture(gl);
    this._texPing = this._createTexture(gl);
    this._fb = gl.createFramebuffer();

    this._ready = true;
    console.log('[WebGLBlur] 初始化成功');
  }

  _compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('[WebGLBlur] 编译失败:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  _createTexture(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  /**
   * 对源 canvas 做高斯模糊，结果绘制到目标 2D context
   * @param {CanvasRenderingContext2D} destCtx - 目标 2D context
   * @param {HTMLCanvasElement} source - 源 canvas
   * @param {number} destW - 目标宽度
   * @param {number} destH - 目标高度
   * @param {number} blurRadius - 模糊半径（CSS px 等效，已含 DPR 补偿）
   * @returns {boolean} 是否成功
   */
  blur(destCtx, source, destW, destH, blurRadius) {
    if (!this._ready || !this._gl) return false;

    const gl = this._gl;

    // 检查 context 是否丢失
    if (gl.isContextLost && gl.isContextLost()) {
      this._ready = false;
      return false;
    }

    const sw = source.width, sh = source.height;
    if (sw === 0 || sh === 0) return false;

    // 调整 canvas 尺寸以匹配源
    if (this._canvas.width !== sw || this._canvas.height !== sh) {
      this._canvas.width = sw;
      this._canvas.height = sh;
    }

    gl.viewport(0, 0, sw, sh);
    gl.useProgram(this._program);

    // 上传源纹理
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texInput);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(this._uTex, 0);

    // 准备 ping 纹理（用于中间结果）
    gl.bindTexture(gl.TEXTURE_2D, this._texPing);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    // blurRadius 决定多少 pass（每个 pass 约 5px 等效模糊）
    // 大模糊需要多轮 pass
    const passCount = Math.max(1, Math.ceil(blurRadius / 5));
    const perPassRadius = blurRadius / passCount;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    let readTex = this._texInput;

    for (let p = 0; p < passCount; p++) {
      const stepX = perPassRadius / sw;
      const stepY = perPassRadius / sh;

      // Pass 1: 水平模糊 → 写入 ping 纹理
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texPing, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.uniform2f(this._uDir, stepX, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 2: 垂直模糊 → 写入屏幕（最后一轮）或 input 纹理（中间轮）
      if (p === passCount - 1) {
        // 最后一轮：写回屏幕 canvas
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        // 中间轮：写回 input 纹理
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texInput, 0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texPing);
      gl.uniform2f(this._uDir, 0, stepY);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      readTex = this._texInput;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.flush();

    // 将 WebGL 结果绘制到目标 2D context
    destCtx.imageSmoothingEnabled = true;
    destCtx.imageSmoothingQuality = 'high';
    destCtx.drawImage(this._canvas, 0, 0, sw, sh, 0, 0, destW, destH);

    return true;
  }

  get isReady() {
    return this._ready;
  }

  destroy() {
    if (this._gl) {
      const gl = this._gl;
      if (this._program) gl.deleteProgram(this._program);
      if (this._texInput) gl.deleteTexture(this._texInput);
      if (this._texPing) gl.deleteTexture(this._texPing);
      if (this._fb) gl.deleteFramebuffer(this._fb);
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
    this._ready = false;
  }
}
