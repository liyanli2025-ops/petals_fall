/**
 * 上报入口脚本（壳）
 * 代理调用 @tencent/qn-page-deploy 中的 report.cjs
 *
 * 用法不变：
 *   node .codebuddy/skills/page-deploy/scripts/report.cjs production-confirm <pageUrl> <action>
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SKILL_DIR = path.resolve(__dirname, '..');
const PACKAGE_NAME = '@tencent/qn-page-deploy';

let reportScriptPath;
try {
  const pkg = require.resolve(`${PACKAGE_NAME}`, { paths: [SKILL_DIR] });
  const pkgDir = path.dirname(pkg);
  reportScriptPath = path.join(pkgDir, 'scripts', 'report.cjs');

  if (!fs.existsSync(reportScriptPath)) {
    throw new Error(`report.cjs 不存在: ${reportScriptPath}`);
  }
} catch (e) {
  console.error(`❌ 无法定位 ${PACKAGE_NAME} 中的 report.cjs: ${e.message}`);
  process.exit(1);
}

const args = process.argv.slice(2).map(a => `"${a}"`).join(' ');
const cmd = `node "${reportScriptPath}" ${args}`;

try {
  execSync(cmd, { stdio: 'inherit', encoding: 'utf-8' });
} catch (e) {
  process.exit(e.status || 1);
}
