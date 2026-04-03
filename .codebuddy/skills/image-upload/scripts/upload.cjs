#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-env node */

/**
 * 图片批量压缩 + 上传到 CDN 脚本
 *
 * 功能:
 * 1. 支持单个图片文件或图片文件夹（递归扫描）
 * 2. 使用 Tinify API 压缩图片（png/jpg/jpeg/webp）
 * 3. 上传到 CDN
 * 4. 输出 CDN URL 列表
 *
 * 使用:
 *   上传图片:   node upload.cjs <图片路径或文件夹路径>
 *   更新配置:   node upload.cjs --set-config <key> <value>
 *
 * 示例:
 *   node upload.cjs /Users/xxx/Desktop/banner.png
 *   node upload.cjs /Users/xxx/Desktop/images
 *   node upload.cjs --set-config TUPLOAD_TOKEN xxx
 */

const fs = require('fs');
const path = require('path');

/**
 * 检查依赖是否已安装
 */
function checkDependencies() {
  const deps = ['@tencent/tupload2', 'tinify', 'chalk', 'pinyin-pro'];
  const missingDeps = [];

  for (const dep of deps) {
    try {
      require.resolve(dep);
    } catch (e) {
      missingDeps.push(dep);
    }
  }

  if (missingDeps.length > 0) {
    console.error(`\n❌ 缺失依赖: ${missingDeps.join(', ')}`);
    console.error('\n请先安装依赖：');
    console.error('  cd .codebuddy/skills/image-upload && tnpm install');
    console.error('\n如果遇到权限问题，请执行：');
    console.error('  sudo chown -R $(whoami) ~/.tnpm');
    console.error('');
    process.exit(1);
  }
}

// 检查依赖
checkDependencies();

// 依赖检查通过后再加载
const chalk = require('chalk');
const tinify = require('tinify');
const tupload = require('@tencent/tupload2');
const { pinyin } = require('pinyin-pro');
const {
  IMAGE_EXTS,
  COMPRESSIBLE_EXTS,
  TINIFY_API_KEY,
  getUploadConfig,
  getCdnBase,
  checkConfig,
  updateConfig,
} = require('../config.cjs');

// 设置 Tinify API Key
tinify.key = TINIFY_API_KEY;

// 命令行参数
const args = process.argv.slice(2);

// ============ 处理 --set-config 命令 ============
if (args[0] === '--set-config') {
  const key = args[1];
  const value = args[2];

  if (!key || !value) {
    console.log(chalk.red('用法: node upload.cjs --set-config <key> <value>'));
    console.log(chalk.yellow('  key: TUPLOAD_TOKEN 或 FOLDER_NAME'));
    console.log(chalk.yellow('  value: 对应的值'));
    process.exit(1);
  }

  const validKeys = ['TUPLOAD_TOKEN', 'FOLDER_NAME', 'TINIFY_API_KEY'];
  if (!validKeys.includes(key)) {
    console.log(chalk.red(`无效的配置项: ${key}`));
    console.log(chalk.yellow(`有效的配置项: ${validKeys.join(', ')}`));
    process.exit(1);
  }

  updateConfig(key, value);
  console.log(chalk.green(`✅ 已更新配置: ${key} = ${value}`));

  // 重新检查配置
  delete require.cache[require.resolve('../config.cjs')];
  const { checkConfig: recheckConfig } = require('../config.cjs');
  const configStatus = recheckConfig();

  if (configStatus.valid) {
    console.log(chalk.green('\n🎉 所有配置已完成，可以开始上传了！'));
  } else {
    console.log(chalk.yellow(`\n还需要配置: ${configStatus.missing.join(', ')}`));
  }

  process.exit(0);
}

// ============ 检查配置 ============
const configStatus = checkConfig();
if (!configStatus.valid) {
  console.log(chalk.red('\n❌ 配置不完整，无法上传'));
  console.log(chalk.yellow('\n缺少以下配置项：'));

  // 输出特殊格式，供 AI 识别并引导用户
  console.log('\n[CONFIG_MISSING_START]');
  console.log(
    JSON.stringify(
      {
        missing: configStatus.missing,
        instructions: {
          TUPLOAD_TOKEN: {
            description: 'CDN 上传 token',
            applyUrl: 'https://fupload.woa.com/create',
            note: '请在申请页面填写上传路径，获取 token 后提供给我',
          },
          FOLDER_NAME: {
            description: '上传路径名称',
            note: '请提供你在申请 token 时填写的路径名称',
          },
        },
      },
      null,
      2,
    ),
  );
  console.log('[CONFIG_MISSING_END]');

  console.log(chalk.cyan('\n请按以下步骤操作：'));

  if (configStatus.missing.includes('TUPLOAD_TOKEN')) {
    console.log(chalk.white('\n1. 申请 TUPLOAD_TOKEN（CDN 上传 token）：'));
    console.log(chalk.blue('   访问: https://fupload.woa.com/create'));
    console.log(chalk.gray('   填写上传路径后获取 token'));
  }

  if (configStatus.missing.includes('FOLDER_NAME')) {
    console.log(chalk.white('\n2. 提供 FOLDER_NAME（上传路径名称）：'));
    console.log(chalk.gray('   即你在申请 token 时填写的路径名称'));
  }

  console.log(chalk.cyan('\n获取后，请按以下格式告诉我：'));
  console.log(chalk.white('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.green('token是xxx'));
  console.log(chalk.green('上传路径是xxx'));
  console.log(chalk.white('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.gray('\n（将 xxx 替换为你申请到的实际值）'));
  console.log('');

  process.exit(1);
}

// ============ 主逻辑 ============

const inputPath = args[0];

if (!inputPath) {
  console.log(chalk.red('用法: node upload.cjs <图片路径或文件夹路径>'));
  console.log(chalk.yellow('\n示例:'));
  console.log(chalk.yellow('  node upload.cjs /Users/xxx/Desktop/banner.png'));
  console.log(chalk.yellow('  node upload.cjs /Users/xxx/Desktop/images/'));
  process.exit(1);
}

// 帮助信息
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: node upload.cjs <图片路径或文件夹路径>');
  console.log('');
  console.log('支持的图片格式:', IMAGE_EXTS.join(', '));
  console.log('可压缩的格式:', COMPRESSIBLE_EXTS.join(', '));
  console.log('');
  console.log('示例:');
  console.log('  node upload.cjs /Users/xxx/Desktop/banner.png');
  console.log('  node upload.cjs /Users/xxx/Desktop/images/');
  console.log('');
  console.log('配置:');
  console.log('  node upload.cjs --set-config TUPLOAD_TOKEN <token>');
  console.log('  node upload.cjs --set-config FOLDER_NAME <路径>');
  process.exit(0);
}

const cdnConfig = getUploadConfig();
const cdnBase = getCdnBase();

/**
 * 递归查找目录中所有图片文件
 */
function findImageFiles(dirPath) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // 跳过隐藏文件

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...findImageFiles(fullPath));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTS.includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * 压缩单个图片
 */
async function compressImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  // 不可压缩的格式直接返回原文件 buffer
  if (!COMPRESSIBLE_EXTS.includes(ext)) {
    return {
      compressed: false,
      buffer: fs.readFileSync(filePath),
      originalSize: fs.statSync(filePath).size,
    };
  }

  try {
    const originalSize = fs.statSync(filePath).size;
    const source = tinify.fromFile(filePath);
    const resultData = await source.toBuffer();

    return {
      compressed: true,
      buffer: resultData,
      originalSize,
      compressedSize: resultData.length,
      savings: (((originalSize - resultData.length) / originalSize) * 100).toFixed(1),
    };
  } catch (error) {
    // 压缩失败，使用原文件
    console.log(chalk.yellow(`  ⚠️ 压缩失败，使用原图: ${error.message}`));
    return {
      compressed: false,
      buffer: fs.readFileSync(filePath),
      originalSize: fs.statSync(filePath).size,
    };
  }
}

/**
 * 上传单个文件到 CDN
 */
async function uploadFile(filePath, buffer, filename) {
  const targetPath = `${cdnConfig.baseUrl}/${filename}`;

  try {
    // 写入临时文件用于上传
    const tmpDir = path.join(__dirname, '../.tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const tmpFile = path.join(tmpDir, filename);
    fs.writeFileSync(tmpFile, buffer);

    await tupload.upload(tmpFile, targetPath, {
      site: cdnConfig.site,
      baseUrl: cdnConfig.baseUrl,
      token: cdnConfig.token,
    });

    // 清理临时文件
    fs.unlinkSync(tmpFile);

    const cdnUrl = `https://${cdnConfig.site}${targetPath}`;
    return { success: true, cdnUrl, filename };
  } catch (error) {
    return { success: false, error: error.message, filename };
  }
}

/**
 * 清理临时目录
 */
function cleanupTmp() {
  const tmpDir = path.join(__dirname, '../.tmp');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 主函数
 */
async function main() {
  const resolvedPath = path.resolve(inputPath);

  // 检查路径是否存在
  if (!fs.existsSync(resolvedPath)) {
    console.log(chalk.red(`\n❌ 路径不存在: ${resolvedPath}`));
    process.exit(1);
  }

  const stat = fs.statSync(resolvedPath);
  let imageFiles = [];

  if (stat.isFile()) {
    // 单个文件
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) {
      console.log(chalk.red(`\n❌ 不支持的文件格式: ${ext}`));
      console.log(chalk.yellow(`支持的格式: ${IMAGE_EXTS.join(', ')}`));
      process.exit(1);
    }
    imageFiles = [resolvedPath];
  } else if (stat.isDirectory()) {
    // 文件夹：递归扫描
    imageFiles = findImageFiles(resolvedPath);
  } else {
    console.log(chalk.red('\n❌ 路径既不是文件也不是文件夹'));
    process.exit(1);
  }

  if (imageFiles.length === 0) {
    console.log(chalk.yellow('\n⚠️ 未找到支持的图片文件'));
    console.log(chalk.yellow(`支持的格式: ${IMAGE_EXTS.join(', ')}`));
    process.exit(0);
  }

  // 显示上传信息
  console.log(chalk.green('\n┏━━━ 🖼️ 图片批量上传 ━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.green(`输入路径: ${resolvedPath}`));
  console.log(chalk.green(`图片数量: ${imageFiles.length}`));
  console.log(chalk.green(`CDN 路径: ${cdnBase}`));
  console.log(chalk.green(''));

  const results = [];
  let totalOriginalSize = 0;
  let totalCompressedSize = 0;

  for (let i = 0; i < imageFiles.length; i++) {
    const filePath = imageFiles[i];
    const originalFilename = path.basename(filePath);
    const ext = path.extname(originalFilename).toLowerCase();
    const nameWithoutExt = path.basename(originalFilename, ext);

    // 处理中文名及特殊字符
    let uploadFilename = originalFilename;
    if (/[\u4e00-\u9fa5]/.test(nameWithoutExt)) {
      uploadFilename = pinyin(nameWithoutExt, { toneType: 'none', type: 'string' })
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9-]/g, '')
        .toLowerCase() + ext;
    } else {
      uploadFilename = nameWithoutExt.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() + ext;
    }

    console.log(chalk.blue(`[${i + 1}/${imageFiles.length}] ${originalFilename}`));
    if (originalFilename !== uploadFilename) {
      console.log(chalk.gray(`  重命名: ${originalFilename} → ${uploadFilename}`));
    }

    // Step 1: 压缩
    const compressResult = await compressImage(filePath);
    totalOriginalSize += compressResult.originalSize;

    if (compressResult.compressed) {
      totalCompressedSize += compressResult.compressedSize;
      console.log(
        chalk.gray(
          `  压缩: ${(compressResult.originalSize / 1024).toFixed(1)}KB → ${(compressResult.compressedSize / 1024).toFixed(1)}KB (节省 ${compressResult.savings}%)`,
        ),
      );
    } else {
      totalCompressedSize += compressResult.originalSize;
      const ext = path.extname(filePath).toLowerCase();
      if (!COMPRESSIBLE_EXTS.includes(ext)) {
        console.log(chalk.gray(`  跳过压缩 (${ext} 格式不支持压缩)`));
      }
    }

    // Step 2: 上传
    const uploadResult = await uploadFile(filePath, compressResult.buffer, uploadFilename);
    uploadResult.originalPath = filePath;
    results.push(uploadResult);

    if (uploadResult.success) {
      console.log(chalk.green(`  ✅ ${uploadResult.cdnUrl}`));
    } else {
      console.log(chalk.red(`  ❌ 上传失败: ${uploadResult.error}`));
    }
    console.log('');
  }

  // 清理临时文件
  cleanupTmp();

  // ============ 输出汇总 ============
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const totalSavings =
    totalOriginalSize > 0
      ? (((totalOriginalSize - totalCompressedSize) / totalOriginalSize) * 100).toFixed(1)
      : '0';

  console.log(chalk.green('━━━ ✅ 上传完成 ━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`总文件数: ${imageFiles.length}`);
  console.log(`成功: ${chalk.green(successful.length)}`);
  if (failed.length > 0) {
    console.log(`失败: ${chalk.red(failed.length)}`);
  }
  console.log(
    `压缩: ${(totalOriginalSize / 1024).toFixed(1)}KB → ${(totalCompressedSize / 1024).toFixed(1)}KB (节省 ${totalSavings}%)`,
  );
  console.log('');

  if (failed.length > 0) {
    console.log(chalk.red('❌ 失败的文件:'));
    failed.forEach((r) => {
      console.log(`   - ${r.filename}: ${r.error}`);
    });
    console.log('');
  }

  if (successful.length > 0) {
    console.log(chalk.green('\n✅ 上传结果表格:'));
    console.log('');
    console.log('| 原路径 | CDN 路径 |');
    console.log('|--------|---------|');
    successful.forEach((r) => {
      console.log(`| ${r.originalPath} | ${r.cdnUrl} |`);
    });
    console.log('');

    // 输出 JSON 格式
    console.log('');
    console.log('📋 JSON 格式:');
    console.log(
      JSON.stringify(
        successful.map((r) => ({
          originalPath: r.originalPath,
          filename: r.filename,
          cdnUrl: r.cdnUrl,
        })),
        null,
        2,
      ),
    );
    console.log('');
  }
}

// 运行
main().catch((error) => {
  cleanupTmp();
  console.error(chalk.red(`❌ 发生错误: ${error.message}`));
  process.exit(1);
});
