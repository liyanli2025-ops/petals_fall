/**
 * 规则运行器入口脚本（壳）
 * 代理调用 @tencent/qn-page-deploy 中的 rule-runner.cjs
 *
 * 用法不变：
 *   node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs <ruleId> <folderPath> [--fix] [--yes]
 *   node .codebuddy/skills/page-deploy/scripts/rule-runner.cjs --list
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SKILL_DIR = path.resolve(__dirname, '..');
const PACKAGE_NAME = '@tencent/qn-page-deploy';

// 设置环境变量
process.env.SKILL_INSTALL_DIR = SKILL_DIR;

let ruleRunnerPath;
try {
  const pkg = require.resolve(`${PACKAGE_NAME}`, { paths: [SKILL_DIR] });
  const pkgDir = path.dirname(pkg);
  ruleRunnerPath = path.join(pkgDir, 'scripts', 'rule-runner.cjs');

  if (!fs.existsSync(ruleRunnerPath)) {
    throw new Error(`rule-runner.cjs 不存在: ${ruleRunnerPath}`);
  }
} catch (e) {
  console.error(`❌ 无法定位 ${PACKAGE_NAME} 中的 rule-runner.cjs: ${e.message}`);
  console.error('请执行: cd .codebuddy/skills/page-deploy && tnpm install');
  process.exit(1);
}

const args = process.argv.slice(2).map(a => `"${a}"`).join(' ');
const cmd = `node "${ruleRunnerPath}" ${args}`;

try {
  execSync(cmd, {
    stdio: 'inherit',
    encoding: 'utf-8',
    env: {
      ...process.env,
      SKILL_INSTALL_DIR: SKILL_DIR,
    },
  });
} catch (e) {
  process.exit(e.status || 1);
}
