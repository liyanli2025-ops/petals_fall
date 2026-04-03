/**
 * 页面发布入口脚本（壳）
 * 
 * 本脚本是 @tencent/qn-page-deploy npm 包的入口代理：
 * 1. 设置环境变量（SECRETS_PATH、SKILL_INSTALL_DIR）
 * 2. 自动检测 npm 包版本并更新
 * 3. 透传所有参数给 npm 包中的 deploy.cjs
 *
 * 用法不变：
 *   node .codebuddy/skills/page-deploy/scripts/deploy.cjs <folderPath> <projectName> <env> [options]
 *   node .codebuddy/skills/page-deploy/scripts/deploy.cjs --set-config <key> <value>
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ============ 路径配置 ============
const SKILL_DIR = path.resolve(__dirname, '..');
const SECRETS_PATH = path.resolve(SKILL_DIR, '../../secrets.json');
const PACKAGE_NAME = '@tencent/qn-page-deploy';

// 设置环境变量，供 npm 包中的 config.cjs 使用
process.env.SECRETS_PATH = SECRETS_PATH;
process.env.SKILL_INSTALL_DIR = SKILL_DIR;

// ============ 自动检测 npm 包版本 ============

/**
 * 获取本地已安装的包版本
 */
function getLocalVersion() {
  try {
    const pkgPath = require.resolve(`${PACKAGE_NAME}/package.json`, {
      paths: [SKILL_DIR],
    });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return null;
  }
}

/**
 * 获取远程最新版本号
 */
function getRemoteVersion() {
  try {
    const version = execSync(`npm view ${PACKAGE_NAME} version 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: SKILL_DIR,
    }).trim();
    return version || null;
  } catch {
    return null;
  }
}

/**
 * 安装/更新包到最新版本
 */
function installLatest() {
  try {
    console.log(`  📦 正在安装 ${PACKAGE_NAME}@latest ...`);
    execSync(`cd "${SKILL_DIR}" && npm install ${PACKAGE_NAME}@latest --save`, {
      encoding: 'utf-8',
      timeout: 60000,
      stdio: 'pipe',
    });
    return true;
  } catch (e) {
    try {
      execSync(`cd "${SKILL_DIR}" && tnpm install ${PACKAGE_NAME}@latest --save`, {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: 'pipe',
      });
      return true;
    } catch {
      console.error(`  ❌ 安装 ${PACKAGE_NAME} 失败: ${e.message}`);
      return false;
    }
  }
}

/**
 * 确保 npm 包是最新版本
 */
function ensureLatestPackage() {
  const localVersion = getLocalVersion();
  const remoteVersion = getRemoteVersion();

  if (!remoteVersion) {
    if (localVersion) {
      console.log(`  ⚠️  无法检查 ${PACKAGE_NAME} 远程版本，使用本地 v${localVersion}`);
    } else {
      console.log(`  ❌ ${PACKAGE_NAME} 未安装且无法获取远程版本`);
      console.log(`  请执行: cd .codebuddy/skills/page-deploy && tnpm install`);
      process.exit(1);
    }
    return;
  }

  if (!localVersion) {
    console.log(`  📦 ${PACKAGE_NAME} 未安装，正在安装 v${remoteVersion} ...`);
    if (!installLatest()) {
      console.log(`  ❌ 安装失败，请手动执行: cd .codebuddy/skills/page-deploy && tnpm install`);
      process.exit(1);
    }
    console.log(`  ✅ 已安装 ${PACKAGE_NAME} v${remoteVersion}`);
    return;
  }

  if (localVersion !== remoteVersion) {
    console.log(`  🔄 ${PACKAGE_NAME} 发现新版本: v${localVersion} → v${remoteVersion}`);
    if (installLatest()) {
      console.log(`  ✅ 已更新到 v${remoteVersion}`);
    } else {
      console.log(`  ⚠️  更新失败，继续使用本地 v${localVersion}`);
    }
  }
}

// ============ 主逻辑 ============

// 检测并更新 npm 包
ensureLatestPackage();

// 解析 npm 包中 deploy.cjs 的路径
let deployScriptPath;
try {
  const pkg = require.resolve(`${PACKAGE_NAME}`, { paths: [SKILL_DIR] });
  const pkgDir = path.dirname(pkg);
  deployScriptPath = path.join(pkgDir, 'scripts', 'deploy.cjs');

  if (!fs.existsSync(deployScriptPath)) {
    throw new Error(`deploy.cjs 不存在: ${deployScriptPath}`);
  }
} catch (e) {
  console.error(`❌ 无法定位 ${PACKAGE_NAME} 中的 deploy.cjs: ${e.message}`);
  console.error('请执行: cd .codebuddy/skills/page-deploy && tnpm install');
  process.exit(1);
}

// 透传所有命令行参数给 npm 包中的 deploy.cjs
const args = process.argv.slice(2).map(a => `"${a}"`).join(' ');
const cmd = `node "${deployScriptPath}" ${args}`;

try {
  execSync(cmd, {
    stdio: 'inherit',
    encoding: 'utf-8',
    env: {
      ...process.env,
      SECRETS_PATH,
      SKILL_INSTALL_DIR: SKILL_DIR,
    },
  });
} catch (e) {
  process.exit(e.status || 1);
}
