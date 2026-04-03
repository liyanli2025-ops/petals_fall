/**
 * 图片上传 Skill 配置文件
 */

const fs = require('fs');
const path = require('path');

// ============ Token 配置 ============
// 从 .codebuddy/secrets.json 统一读取 Token
const SECRETS_PATH = path.resolve(__dirname, '../../secrets.json');
let secrets = {};
try {
  secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
} catch (e) {
  console.warn('[image-upload] 未找到 .codebuddy/secrets.json，请先配置 Token。');
}

// 优先从 page-deploy 读取以实现参数共用
const uploadSecrets = Object.assign({}, secrets['image-upload'], secrets['page-deploy']);
const TUPLOAD_TOKEN = uploadSecrets.TUPLOAD_TOKEN || '';
const FOLDER_NAME = uploadSecrets.FOLDER_NAME || '';

// Tinify API Key (复用 design-to-code 的 key)
const TINIFY_API_KEY = uploadSecrets.TINIFY_API_KEY || 'L2SXxnFRQWjl9s3XtRr4N9gkffGtHbyz';

// 支持的图片格式
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico'];
// Tinify 可压缩的格式
const COMPRESSIBLE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

/**
 * 检查配置是否完整
 * @returns {object} { valid: boolean, missing: string[] }
 */
function checkConfig() {
  const missing = [];

  if (!TUPLOAD_TOKEN || TUPLOAD_TOKEN.trim() === '') {
    missing.push('TUPLOAD_TOKEN');
  }
  if (!FOLDER_NAME || FOLDER_NAME.trim() === '') {
    missing.push('FOLDER_NAME');
  }

  return {
    valid: missing.length === 0,
    missing,
    current: {
      TUPLOAD_TOKEN,
      FOLDER_NAME,
    },
  };
}

/**
 * 更新 secrets.json 中的配置值
 * @param {string} key - 配置项名称
 * @param {string} value - 配置项值
 */
function updateConfig(key, value) {
  // 对 FOLDER_NAME 进行路径规范化：去除首尾的 /
  if (key === 'FOLDER_NAME') {
    value = value.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  let currentSecrets = {};
  try {
    currentSecrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
  } catch (e) {
    // secrets.json 不存在，创建新的
  }

  // 写入时统一写到 page-deploy 以实现跨 skill 参数共用
  if (!currentSecrets['page-deploy']) {
    currentSecrets['page-deploy'] = {};
  }
  currentSecrets['page-deploy'][key] = value;
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(currentSecrets, null, 2) + '\n', 'utf-8');
}

/**
 * 获取上传配置
 */
function getUploadConfig() {
  return {
    site: 'mat1.gtimg.com',
    baseUrl: `/qqcdn/${FOLDER_NAME}`,
    token: TUPLOAD_TOKEN,
  };
}

/**
 * 获取 CDN 基础路径
 */
function getCdnBase() {
  return `https://mat1.gtimg.com/qqcdn/${FOLDER_NAME}`;
}

module.exports = {
  IMAGE_EXTS,
  COMPRESSIBLE_EXTS,
  TINIFY_API_KEY,
  getUploadConfig,
  getCdnBase,
  checkConfig,
  updateConfig,
};