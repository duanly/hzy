#!/usr/bin/env node
/**
 * 从麻将牌原图中提取牌体
 *
 * 输入：web/public/mj-tiles/ 中的 136x457 PNG 图
 * 输出：web/public/mj-tile-bodies/ 中的透明背景牌体 PNG
 *
 * 三种牌体：
 *  1. standing - 手牌（立着的，大仰角）- 从每张图底部的主牌提取
 *  2. flat - 下地/弃牌区的牌（平的，小仰角）- 从图上方的小牌提取
 *  3. back - 牌背（背面朝上）- 从牌墙侧面提取或合成
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const INPUT_DIR = 'web/public/mj-tiles';
const OUTPUT_DIR = 'web/public/mj-tile-bodies';

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * 判断像素是否为桌布背景色
 * 桌布是青绿色：蓝绿分量高，红分量低
 */
function isBgColor(r, g, b) {
  // 典型青绿色桌布
  if (r < 40 && g > 70 && b > 80 && g > r * 1.5 && b > r * 1.8) return true;
  // 较亮的桌布
  if (r < 100 && g > 100 && b > 110 && g > r * 1.2 && b > r * 1.3) return true;
  // 深色阴影区域的桌布
  if (r < 25 && g < 70 && b < 80 && g > r * 1.5 && b > r * 1.8) return true;
  return false;
}

/**
 * 判断像素是否为底部黑条（手机 Home Indicator）
 * 只在图像最底部的几行有效
 */
function isBottomBlackBar(r, g, b) {
  // 纯黑或近黑色
  if (r < 15 && g < 15 && b < 15) return true;
  // 深灰色（黑条边缘的抗锯齿）
  if (r < 40 && g < 40 && b < 40 && Math.abs(r - g) < 10 && Math.abs(g - b) < 10) return true;
  return false;
}

/**
 * 修复底部 Home Indicator 条（iPhone 底部横条）
 *
 * 方法：
 *  1. 按列检测底部连续的"均匀纯色"段（home 条的特征）
 *  2. 用该列的牌面主色（从牌面中间区域取样，即大面积白色部分）来填充
 *  3. 这样即使图案延伸到了 home 条区域，填充的也是牌面底色（白色），
 *     而不是把图案颜色往下"拉长"
 *
 * 支持黑色和浅灰色（白色）两种 home 条。
 * 返回修复的总像素数
 */
function fixBottomBlackBar(pixels, w, h) {
  const minBarHeight = 6;    // home 条最小高度
  const maxBarHeight = 16;   // home 条最大高度
  const colorTol = 6;        // 条内颜色一致性容差
  const brightDiff = 20;     // 条与牌面亮度差（RGB均值差）
  const maxCheck = 25;       // 最多从底部往上检查多少行
  const faceSampleY = Math.floor(h * 0.35); // 牌面主色采样行（上方大面积白色区域）
  const checkRows = Math.min(maxCheck, h);
  let fixedPixels = 0;

  for (let x = 0; x < w; x++) {
    // 先取牌面中间偏上位置的颜色作为"牌面主色"（那里基本都是白色牌底）
    const faceI = (faceSampleY * w + x) * 3;
    const faceR = pixels[faceI], faceG = pixels[faceI + 1], faceB = pixels[faceI + 2];
    const faceBright = (faceR + faceG + faceB) / 3;

    // 从底部往上找颜色高度一致的连续段
    const bottomI = ((h - 1) * w + x) * 3;
    let baseR = pixels[bottomI], baseG = pixels[bottomI + 1], baseB = pixels[bottomI + 2];
    const bottomBright = (baseR + baseG + baseB) / 3;
    let barHeight = 1;

    for (let y = h - 2; y >= h - checkRows; y--) {
      const i = (y * w + x) * 3;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const diff = Math.abs(r - baseR) + Math.abs(g - baseG) + Math.abs(b - baseB);
      if (diff <= colorTol * 3) {
        barHeight++;
      } else {
        break;
      }
    }

    // 高度不在合理范围，跳过
    if (barHeight < minBarHeight || barHeight > maxBarHeight) continue;

    // 亮度差不够（底部颜色跟牌面主色差不多），说明是牌面本身，不是 home 条
    if (Math.abs(bottomBright - faceBright) < brightDiff) continue;

    // 用牌面主色（白色）填充 home 条区域
    const topOfBarY = h - barHeight;
    for (let y = topOfBarY; y < h; y++) {
      const dstI = (y * w + x) * 3;
      pixels[dstI] = faceR;
      pixels[dstI + 1] = faceG;
      pixels[dstI + 2] = faceB;
      fixedPixels++;
    }
  }

  return fixedPixels;
}

/**
 * 从图像区域中提取牌体（去掉背景）
 * 返回 { left, top, width, height, buffer }
 */
async function extractTileBody(imageBuffer, region, { fixBlackBar = false, fixedSize = false } = {}) {
  // 先裁剪区域
  let pipeline = sharp(imageBuffer);
  if (region) {
    pipeline = pipeline.extract(region);
  }
  const { data, info } = await pipeline
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const pixels = new Uint8ClampedArray(data);

  // 修复底部黑条（如果开启）
  if (fixBlackBar) {
    fixBottomBlackBar(pixels, w, h);
  }

  // 固定尺寸模式：不做自动边界裁剪，直接用输入区域的完整尺寸
  let minX = 0, minY = 0, maxX = w - 1, maxY = h - 1;

  if (!fixedSize) {
    // 第一步：找牌的边界
    let found = false;
    minX = w; minY = h; maxX = 0; maxY = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (!isBgColor(r, g, b)) {
          found = true;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (!found) {
      return null;
    }

    // 稍微扩展边界（2px），保留边缘抗锯齿
    const expand = 2;
    minX = Math.max(0, minX - expand);
    minY = Math.max(0, minY - expand);
    maxX = Math.min(w - 1, maxX + expand);
    maxY = Math.min(h - 1, maxY + expand);
  }

  const tileW = maxX - minX + 1;
  const tileH = maxY - minY + 1;

  // 第二步：创建带 alpha 通道的输出像素
  const outPixels = Buffer.alloc(tileW * tileH * 4);

  for (let y = 0; y < tileH; y++) {
    for (let x = 0; x < tileW; x++) {
      const srcI = ((minY + y) * w + (minX + x)) * 3;
      const dstI = (y * tileW + x) * 4;

      const r = pixels[srcI];
      const g = pixels[srcI + 1];
      const b = pixels[srcI + 2];

      outPixels[dstI] = r;
      outPixels[dstI + 1] = g;
      outPixels[dstI + 2] = b;

      if (isBgColor(r, g, b)) {
        // 检查周围邻居中有多少是牌像素
        let tileCount = 0;
        let totalCount = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < tileW && ny >= 0 && ny < tileH) {
              totalCount++;
              const ni = ((minY + ny) * w + (minX + nx)) * 3;
              const nr = pixels[ni], ng = pixels[ni + 1], nb = pixels[ni + 2];
              if (!isBgColor(nr, ng, nb)) tileCount++;
            }
          }
        }
        // alpha 值取决于有多少邻居是牌像素
        if (tileCount > 0) {
          outPixels[dstI + 3] = Math.min(255, Math.floor(255 * tileCount / totalCount * 1.8));
        } else {
          outPixels[dstI + 3] = 0;
        }
      } else {
        outPixels[dstI + 3] = 255;
      }
    }
  }

  const outputBuffer = await sharp(outPixels, {
    raw: { width: tileW, height: tileH, channels: 4 }
  }).png().toBuffer();

  return {
    left: minX + (region?.left || 0),
    top: minY + (region?.top || 0),
    width: tileW,
    height: tileH,
    buffer: outputBuffer
  };
}

// 立牌的标准位置（所有图底部的牌大小一致）
// 绿色顶边约在 y=264，从 y=263 开始，顶部只留 1px 余量
// 高度 194px（y=263 到 y=456），底部到图片最底部（home 条自动修复）
const STANDING_TOP = 263;
const STANDING_HEIGHT = 194;

/**
 * 评估一张图底部立牌的"干净程度"（home 条越少分越高）
 * 用于从多个变体中选择最佳图源
 */
async function scoreBottomBar(filename) {
  const filePath = path.join(INPUT_DIR, filename);
  const buffer = fs.readFileSync(filePath);
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;

  // 找牌的左右边界（y=350 处）
  const scanY = 350;
  let leftX = 0, rightX = w - 1;
  for (let x = 0; x < w; x++) {
    const i = (scanY * w + x) * 3;
    if (!isBgColor(data[i], data[i + 1], data[i + 2])) { leftX = x; break; }
  }
  for (let x = w - 1; x >= 0; x--) {
    const i = (scanY * w + x) * 3;
    if (!isBgColor(data[i], data[i + 1], data[i + 2])) { rightX = x; break; }
  }
  if (rightX - leftX < 50) return -999;

  const midX = Math.floor((leftX + rightX) / 2);

  // 牌面中间的亮度（参考值）
  const faceY = 320;
  const faceI = (faceY * w + midX) * 3;
  const faceBright = (data[faceI] + data[faceI + 1] + data[faceI + 2]) / 3;

  // 底部 5 行的平均亮度和方差
  let brightSum = 0;
  const bottomBrights = [];
  for (let y = h - 5; y < h; y++) {
    const i = (y * w + midX) * 3;
    const b = (data[i] + data[i + 1] + data[i + 2]) / 3;
    bottomBrights.push(b);
    brightSum += b;
  }
  const avgBright = brightSum / 5;

  let variance = 0;
  for (const b of bottomBrights) variance += Math.abs(b - avgBright);
  variance /= 5;

  const brightDiff = Math.abs(avgBright - faceBright);

  // 评分：
  //  100 分 = 完全干净（底部就是牌面）
  //  0 分   = 黑色 home 条
  //  50 分  = 浅色 home 条（跟牌面色差大）
  //  越低越差
  if (avgBright < 30) return 0; // 纯黑条，最差
  if (brightDiff < 20 && variance < 8) return 100; // 跟牌面颜色接近，干净
  if (variance < 3 && brightDiff > 15) return 40; // 均匀但色差大，是浅色条
  return 60; // 不确定，中等
}

/**
 * 从一张完整图中提取底部的立牌（手牌样式）
 * 所有牌都在图片底部，位置固定，直接裁剪固定区域
 */
async function extractStandingTile(filename) {
  const filePath = path.join(INPUT_DIR, filename);
  const buffer = fs.readFileSync(filePath);

  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;

  // 固定区域：从底部往上取
  const topY = STANDING_TOP;
  const height = STANDING_HEIGHT;

  // 左右边界：在牌面中间高度扫描
  const scanY = Math.floor(topY + height * 0.5);
  let leftX = 0, rightX = w - 1;

  for (let x = 0; x < w; x++) {
    const i = (scanY * w + x) * 3;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (!isBgColor(r, g, b)) {
      leftX = x;
      break;
    }
  }
  for (let x = w - 1; x >= 0; x--) {
    const i = (scanY * w + x) * 3;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (!isBgColor(r, g, b)) {
      rightX = x;
      break;
    }
  }

  // 扩展边界（保留边缘抗锯齿）
  leftX = Math.max(0, leftX - 3);
  rightX = Math.min(w - 1, rightX + 3);

  const region = {
    left: leftX,
    top: topY,
    width: rightX - leftX + 1,
    height: height
  };

  return extractTileBody(buffer, region, { fixBlackBar: true, fixedSize: true });
}

/**
 * 从一张完整图中提取顶部的平牌（弃牌区样式）
 * 比如 tong2.png 顶部有个白板（侧面视角的小牌）
 */
async function extractFlatTile(filename, searchRegion) {
  const filePath = path.join(INPUT_DIR, filename);
  const buffer = fs.readFileSync(filePath);

  return extractTileBody(buffer, searchRegion);
}

/**
 * 合成牌背
 * 牌背是深绿色的长方形（带圆角），模拟麻将牌的背面
 * 牌背用于牌墙和其他玩家的手牌，都是立着的，所以比例跟立牌一致
 */
async function generateTileBack(standingW, standingH) {
  // 牌背尺寸：跟立牌一样大（立着放，牌墙和别人手牌）
  const tileW = standingW;
  const tileH = standingH;

  // 麻将牌背的深绿色
  const baseR = 30;
  const baseG = 100;
  const baseB = 55;

  // 创建牌背图像
  const pixels = Buffer.alloc(tileW * tileH * 4);

  // 圆角半径（小一点，麻将牌的圆角不大）
  const radius = Math.floor(Math.min(tileW, tileH) * 0.08);

  function insideRoundedRect(x, y) {
    if (x < radius && y < radius) {
      const dx = radius - 1 - x, dy = radius - 1 - y;
      return dx * dx + dy * dy <= radius * radius;
    }
    if (x >= tileW - radius && y < radius) {
      const dx = x - (tileW - radius), dy = radius - 1 - y;
      return dx * dx + dy * dy <= radius * radius;
    }
    if (x < radius && y >= tileH - radius) {
      const dx = radius - 1 - x, dy = y - (tileH - radius);
      return dx * dx + dy * dy <= radius * radius;
    }
    if (x >= tileW - radius && y >= tileH - radius) {
      const dx = x - (tileW - radius), dy = y - (tileH - radius);
      return dx * dx + dy * dy <= radius * radius;
    }
    return true;
  }

  // 计算边缘距离（用于边缘抗锯齿）
  function edgeAlpha(x, y) {
    if (insideRoundedRect(x, y)) {
      // 检查是否在边缘附近
      let edgeDist = 999;
      // 左边缘
      if (x < radius + 2) edgeDist = Math.min(edgeDist, x);
      // 右边缘
      if (x >= tileW - radius - 2) edgeDist = Math.min(edgeDist, tileW - 1 - x);
      // 上边缘
      if (y < radius + 2) edgeDist = Math.min(edgeDist, y);
      // 下边缘
      if (y >= tileH - radius - 2) edgeDist = Math.min(edgeDist, tileH - 1 - y);

      if (edgeDist < 2) return 180 + edgeDist * 30; // 边缘半透明
      return 255;
    }
    // 在外面，检查距离边缘有多近
    if (x >= -1 && x <= tileW && y >= -1 && y <= tileH) {
      return 80; // 边缘外的抗锯齿
    }
    return 0;
  }

  for (let y = 0; y < tileH; y++) {
    for (let x = 0; x < tileW; x++) {
      const i = (y * tileW + x) * 4;

      const inside = insideRoundedRect(x, y);
      const alpha = inside ? 255 : edgeAlpha(x, y);

      if (alpha === 0) {
        pixels[i] = 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
        pixels[i + 3] = 0;
        continue;
      }

      // 渐变：上亮下暗，模拟立体效果
      const t = y / tileH;
      let r, g, b;

      if (t < 0.25) {
        // 顶部高光
        const lt = t / 0.25;
        const factor = 1.35 - lt * 0.25;
        r = Math.min(255, Math.floor(baseR * factor));
        g = Math.min(255, Math.floor(baseG * factor));
        b = Math.min(255, Math.floor(baseB * factor));
      } else if (t < 0.65) {
        // 中间主体
        const lt = (t - 0.25) / 0.4;
        const factor = 1.1 - lt * 0.2;
        r = Math.floor(baseR * factor);
        g = Math.floor(baseG * factor);
        b = Math.floor(baseB * factor);
      } else {
        // 底部阴影
        const lt = (t - 0.65) / 0.35;
        const factor = 0.9 - lt * 0.25;
        r = Math.max(0, Math.floor(baseR * factor));
        g = Math.max(0, Math.floor(baseG * factor));
        b = Math.max(0, Math.floor(baseB * factor));
      }

      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = alpha;
    }
  }

  // 添加一个简单的装饰图案（模拟麻将牌背的花纹）
  // 中间一个矩形框
  const frameLeft = Math.floor(tileW * 0.2);
  const frameRight = tileW - frameLeft;
  const frameTop = Math.floor(tileH * 0.25);
  const frameBottom = tileH - frameTop;
  const frameThickness = 2;

  for (let y = frameTop; y < frameBottom; y++) {
    for (let x = frameLeft; x < frameRight; x++) {
      const onFrame =
        (x >= frameLeft && x < frameLeft + frameThickness) ||
        (x >= frameRight - frameThickness && x < frameRight) ||
        (y >= frameTop && y < frameTop + frameThickness) ||
        (y >= frameBottom - frameThickness && y < frameBottom);

      if (onFrame) {
        const i = (y * tileW + x) * 4;
        // 更暗的绿色边框
        pixels[i] = Math.max(0, pixels[i] - 15);
        pixels[i + 1] = Math.max(0, pixels[i + 1] - 25);
        pixels[i + 2] = Math.max(0, pixels[i + 2] - 15);
      }
    }
  }

  return sharp(pixels, {
    raw: { width: tileW, height: tileH, channels: 4 }
  }).png().toBuffer();
}

// 主函数
async function main() {
  console.log('开始提取牌体...');

  // 1. 提取立牌（手牌样式）- 用 baiban.png 作为干净的牌体
  console.log('\n1. 提取立牌（手牌样式）...');
  const standing = await extractStandingTile('baiban.png');
  if (standing) {
    console.log(`   立牌尺寸: ${standing.width} x ${standing.height}`);
    console.log(`   位置: left=${standing.left}, top=${standing.top}`);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'tile-standing.png'), standing.buffer);
    console.log('   ✓ 已保存 tile-standing.png');
  }

  // 2. 提取平牌（弃牌区样式）- 从 dongc.png 左上角的白板提取
  console.log('\n2. 提取平牌（弃牌区样式）...');
  // dongc.png 左上角有一个平放在桌上的白板牌（牌面朝上）
  // 位置: x=0, y=128, 宽约69, 高约103
  const flat = await extractFlatTile('dongc.png', {
    left: 0,
    top: 128,
    width: 70,
    height: 103
  });
  if (flat) {
    console.log(`   平牌尺寸: ${flat.width} x ${flat.height}`);
    console.log(`   位置: left=${flat.left}, top=${flat.top}`);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'tile-flat.png'), flat.buffer);
    console.log('   ✓ 已保存 tile-flat.png');
  }

  // 3. 生成牌背
  console.log('\n3. 生成牌背...');
  const backBuffer = await generateTileBack(standing?.width || 120, standing?.height || 200);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'tile-back.png'), backBuffer);
  console.log('   ✓ 已保存 tile-back.png');

  // 4. 提取所有牌的牌面（立牌样式）
  console.log('\n4. 提取所有牌面（立牌样式）...');

  const tileBases = [
    'wan1', 'wan2', 'wan3', 'wan4', 'wan5',
    'wan6', 'wan7', 'wan8', 'wan9',
    'tiao1', 'tiao2', 'tiao3', 'tiao4', 'tiao5',
    'tiao6', 'tiao7', 'tiao8', 'tiao9',
    'tong1', 'tong2', 'tong3', 'tong4', 'tong5',
    'tong6', 'tong7', 'tong8', 'tong9',
    'hongzhong', 'dong', 'nan', 'bei', 'baiban',
  ];

  const faceDir = path.join(OUTPUT_DIR, 'faces-standing');
  if (!fs.existsSync(faceDir)) fs.mkdirSync(faceDir, { recursive: true });

  for (const base of tileBases) {
    // 找出该牌的所有变体文件（base.png, baseb.png, basec.png ...）
    const allFiles = fs.readdirSync(INPUT_DIR).filter(f => {
      if (f === base + '.png') return true;
      return f.startsWith(base) && /^[a-z]\.png$/.test(f.substring(base.length));
    }).sort();

    if (allFiles.length === 0) {
      console.log(`   跳过 (不存在): ${base}`);
      continue;
    }

    // 从所有变体中选底部最干净的一张
    let bestFile = allFiles[0];
    let bestScore = -999;

    for (const f of allFiles) {
      const score = await scoreBottomBar(f);
      if (score > bestScore) {
        bestScore = score;
        bestFile = f;
      }
    }

    const usedVariant = bestFile !== base + '.png' ? ` (用 ${bestFile})` : '';

    try {
      const tile = await extractStandingTile(bestFile);
      if (tile) {
        const outName = base + '-face.png';
        fs.writeFileSync(path.join(faceDir, outName), tile.buffer);
        console.log(`   ✓ ${base} -> ${outName} (${tile.width}x${tile.height})${usedVariant}`);
      }
    } catch (e) {
      console.log(`   ✗ ${base}: ${e.message}`);
    }
  }

  console.log('\n✓ 提取完成！输出目录:', OUTPUT_DIR);
}

main().catch(console.error);
