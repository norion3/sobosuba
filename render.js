/**
 * render.js
 * @version v8.11 (Game-Over Afterglow Static Red Border & Result-Screen Inscribed Circle Skip - Phase 3)
 * @changes
 *   - drawWarningOverlay() でゲームオーバー余韻中（gameState.isGameOver === true）の即リターンを改め、点滅を止めて真っ赤な内壁ボーダー（固定アルファ 0.75・線幅 12px・内壁クリップ）＋ 薄い赤ティント（0.12）を静かに保持するよう変更し、確定瞬間の突然消灯および main.js 側 bothPressedRatio = 1 のデッド代入を解消
 *   - drawSingleSoftBody() の最大内接円探索へ !isGameOver ガードを追加し、初回キャッシュ生成を保証したままリザルト静止中の不要な 3 フレーム再探索をスキップして省電力性を向上
 * 
 * ソフトボディの中空ビーズリングを滑らかなスライムとして描画するレンダリングモジュール
 * 
 * 外殻パーティクルの「外縁（外側のフチ）」へ収縮補正および描画専用の1パス軽量スムージングを適用して
 * ベジェ曲線で結ぶことで、隙間なく密着して液体のように美しく変形する本家sobosuba風のスライムを表現します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, ACTIVE_THEME, JELLY_CONFIG, EFFECTS, CONTAINER, PHYSICS, FLOAT_BAR } from '/sobosuba/constants.js?v=7';
import { isPointInsidePolygon } from '/sobosuba/overlap_solver.js?v=7';

// ==========================================
// ゼロアロケーション（毎フレームGC負荷削減）用事前確保バッファ ＆ フォント文字列キャッシュ
// ==========================================
const INITIAL_OUTER_POINTS_CAPACITY = 48;
const outerPointsBuffer = Array.from({ length: INITIAL_OUTER_POINTS_CAPACITY }, () => ({ x: 0, y: 0 }));
const smoothedPointsBuffer = Array.from({ length: INITIAL_OUTER_POINTS_CAPACITY }, () => ({ x: 0, y: 0 }));
const hoppingCompositesBuffer = [];

// 0.5px 刻み量子化フォント文字列キャッシュ（毎フレームの文字列結合とグリフキャッシュ再生成を削減）
const mergedFontCache = new Map();
const unmergedFontCache = new Map();

// 通常レイヤー「全本体描画 → 全数字最前面描画」2パス分離用の事前確保テキストバッファ
const INITIAL_DEFERRED_TEXT_CAPACITY = 48;
const deferredTextBuffer = Array.from({ length: INITIAL_DEFERRED_TEXT_CAPACITY }, () => ({
    x: 0,
    y: 0,
    angle: 0,
    scale: 1,
    valueText: '',
    fillStyle: '#000000',
    alpha: 1,
    font: ''
}));
let deferredTextCount = 0;

/**
 * フォントサイズを 0.5px 刻みで量子化し、合体済み／未合体別の生成済みフォント文字列をキャッシュから取得する
 * @param {boolean} isMerged
 * @param {number} fontSize
 * @returns {string}
 */
function getCachedFontString(isMerged, fontSize) {
    const halfPxKey = Math.round(fontSize * 2);
    const cache = isMerged ? mergedFontCache : unmergedFontCache;
    let fontStr = cache.get(halfPxKey);
    if (!fontStr) {
        fontStr = `${isMerged ? '900' : '600'} ${(halfPxKey * 0.5).toFixed(1)}px "Courier New", Courier, monospace`;
        cache.set(halfPxKey, fontStr);
    }
    return fontStr;
}

/**
 * 事前確保した外縁座標バッファおよびスムージングバッファの容量が不足する場合のみ拡張する
 * @param {number} requiredCount
 */
function ensureOuterPointsCapacity(requiredCount) {
    while (outerPointsBuffer.length < requiredCount) {
        outerPointsBuffer.push({ x: 0, y: 0 });
    }
    while (smoothedPointsBuffer.length < requiredCount) {
        smoothedPointsBuffer.push({ x: 0, y: 0 });
    }
}

/**
 * 遅延テキスト描画バッファへ描画パラメータをゼロアロケーションで追加する
 */
function pushDeferredText(x, y, angle, scale, valueText, fillStyle, alpha, font) {
    if (deferredTextCount >= deferredTextBuffer.length) {
        deferredTextBuffer.push({
            x: 0,
            y: 0,
            angle: 0,
            scale: 1,
            valueText: '',
            fillStyle: '#000000',
            alpha: 1,
            font: ''
        });
    }
    const item = deferredTextBuffer[deferredTextCount++];
    item.x = x;
    item.y = y;
    item.angle = angle;
    item.scale = scale;
    item.valueText = valueText;
    item.fillStyle = fillStyle;
    item.alpha = alpha;
    item.font = font;
}

/**
 * 1件分のゼリー数字テキストを描画する共通ヘルパー
 */
function drawJellyTextItem(ctx, x, y, angle, scale, valueText, fillStyle, alpha, font) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    if (scale !== 1.0) {
        ctx.scale(scale, scale);
    }
    ctx.fillStyle = fillStyle;
    ctx.globalAlpha = alpha;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(valueText, 0, 0);
    ctx.restore();
}

/**
 * 指定座標 (px, py) が、自身より後（手前）に描画される通常レイヤーのゼリー物理リング内部に
 * 覆われているかを AABB 枝刈り ＋ Point-in-Polygon で高速判定する
 * @param {number} px
 * @param {number} py
 * @param {Array<Matter.Composite>} composites
 * @param {number} startIndex - 自身の次インデックス（compIndex + 1）
 * @returns {boolean}
 */
function isPointOccludedByFrontJellies(px, py, composites, startIndex) {
    if (!composites || startIndex < 0) return false;
    for (let j = startIndex; j < composites.length; j++) {
        const other = composites[j];
        if (!other ||
            other.label !== 'jelly_composite' ||
            other.isBarHopping ||
            !other.particles ||
            other.particles.length < 3) {
            continue;
        }
        const aabb = other.aabb;
        if (aabb && (px < aabb.minX || px > aabb.maxX || py < aabb.minY || py > aabb.maxY)) {
            continue;
        }
        if (isPointInsidePolygon(px, py, other.particles, other.particles.length)) {
            return true;
        }
    }
    return false;
}

/**
 * 点 (px, py) から外縁ポリゴン全辺（線分）までの最短距離の二乗を算出する軽量ヘルパー
 * @param {number} px
 * @param {number} py
 * @param {Array<{x: number, y: number}>} pts
 * @param {number} n
 * @returns {number}
 */
function computeMinEdgeDistSq(px, py, pts, n) {
    let minDistSq = Infinity;
    for (let j = 0; j < n; j++) {
        const p1 = pts[j];
        const p2 = pts[(j + 1) % n];
        const ex = p2.x - p1.x;
        const ey = p2.y - p1.y;
        const lenSq = ex * ex + ey * ey;

        let t = 0;
        if (lenSq > 1e-8) {
            t = ((px - p1.x) * ex + (py - p1.y) * ey) / lenSq;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
        }

        const qx = p1.x + ex * t;
        const qy = p1.y + ey * t;
        const dx = px - qx;
        const dy = py - qy;
        const dSq = dx * dx + dy * dy;
        if (dSq < minDistSq) {
            minDistSq = dSq;
        }
    }
    return minDistSq;
}

/**
 * 閉じた外縁パスを二次ベジェ曲線で構築する共通ヘルパー
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x: number, y: number}>} pts
 * @param {number} n
 */
function traceSmoothBlobPath(ctx, pts, n) {
    ctx.beginPath();
    let xc = (pts[0].x + pts[n - 1].x) * 0.5;
    let yc = (pts[0].y + pts[n - 1].y) * 0.5;
    ctx.moveTo(xc, yc);

    for (let j = 0; j < n; j++) {
        const currPt = pts[j];
        const nextPt = pts[(j + 1) % n];
        xc = (currPt.x + nextPt.x) * 0.5;
        yc = (currPt.y + nextPt.y) * 0.5;
        ctx.quadraticCurveTo(currPt.x, currPt.y, xc, yc);
    }
    ctx.closePath();
}

/**
 * 全モバイルWebView互換の角丸矩形パス構築ヘルパー（サイドバーLED描画用）
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function traceRoundedRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
}

// ==========================================
// サブ関数 1：背景・一体グレー外枠フレーム・内壁基準45度角カット・上枠（左右2本黒ゲージ＆フック白点）
// ==========================================
function drawContainerAndTopBar(ctx, composites, gameState) {
    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;
    const cut = CONTAINER.CORNER_CUT_SIZE;

    const innerLeft = frameW;
    const innerRight = GAME_WIDTH - frameW;
    const innerTop = topBarH;
    const innerBottom = GAME_HEIGHT - frameW;

    // 1. 背景のクリア（漆黒のプレイフィールド）
    ctx.fillStyle = ACTIVE_THEME.containerBg || '#080808';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // 2. 容器底面の45度角カット三角形（physics.js の内壁基準スロープと 0.000px 誤差同期）
    ctx.fillStyle = ACTIVE_THEME.cornerFill || '#262626';

    ctx.beginPath();
    ctx.moveTo(innerLeft, innerBottom - cut);
    ctx.lineTo(innerLeft + cut, innerBottom);
    ctx.lineTo(innerLeft, innerBottom);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(innerRight, innerBottom - cut);
    ctx.lineTo(innerRight - cut, innerBottom);
    ctx.lineTo(innerRight, innerBottom);
    ctx.closePath();
    ctx.fill();

    // 3. 本家準拠の一体グレー外枠フレーム（左・右・底 8px / 上枠 12px）
    ctx.fillStyle = '#2c2f36';
    // 上枠
    ctx.fillRect(0, 0, GAME_WIDTH, topBarH);
    // 左枠
    ctx.fillRect(0, topBarH, frameW, GAME_HEIGHT - topBarH);
    // 右枠
    ctx.fillRect(GAME_WIDTH - frameW, topBarH, frameW, GAME_HEIGHT - topBarH);
    // 底枠
    ctx.fillRect(frameW, GAME_HEIGHT - frameW, GAME_WIDTH - frameW * 2, frameW);

    // 容器の内壁エッジライン（左右内壁・斜め45度スロープ・底面・上枠下端）
    ctx.strokeStyle = ACTIVE_THEME.wallStroke || '#3a3a3a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(innerLeft, innerTop);
    ctx.lineTo(innerLeft, innerBottom - cut);
    ctx.lineTo(innerLeft + cut, innerBottom);
    ctx.lineTo(innerRight - cut, innerBottom);
    ctx.lineTo(innerRight, innerBottom - cut);
    ctx.lineTo(innerRight, innerTop);
    ctx.lineTo(innerLeft, innerTop);
    ctx.stroke();

    // 4. 上枠バー内の本家準拠「左右2本スポーナー黒ゲージ（黒が埋まると次のツモが来る）」
    const gauges = (gameState && gameState.spawnerGauges) ? gameState.spawnerGauges : null;
    const leftRatio = gauges ? Math.max(0, Math.min(1, gauges.leftGaugeRatio || 0)) : 0;
    const rightRatio = gauges ? Math.max(0, Math.min(1, gauges.rightGaugeRatio || 0)) : 0;

    const trackMarginX = frameW + 10;
    const centerGap = 24;
    const trackH = 6;
    const trackY = (topBarH - trackH) * 0.5;
    const trackW = (GAME_WIDTH - trackMarginX * 2 - centerGap) * 0.5;
    const leftTrackX = trackMarginX;
    const rightTrackX = GAME_WIDTH - trackMarginX - trackW;

    // ゲージ溝のベース（明るめのグレー：空きが少ない状態）
    ctx.fillStyle = '#5a5f6b';
    ctx.fillRect(leftTrackX, trackY, trackW, trackH);
    ctx.fillRect(rightTrackX, trackY, trackW, trackH);

    // 左スポーナー黒ゲージ（左端から中央に向かって黒が埋まる）
    if (leftRatio > 0.005) {
        const fillW = trackW * leftRatio;
        ctx.fillStyle = '#080808';
        ctx.fillRect(leftTrackX, trackY, fillW, trackH);
    }

    // 右スポーナー黒ゲージ（右端から中央に向かって黒が埋まる）
    if (rightRatio > 0.005) {
        const fillW = trackW * rightRatio;
        ctx.fillStyle = '#080808';
        ctx.fillRect(rightTrackX + (trackW - fillW), trackY, fillW, trackH);
    }

    // ゲージ溝の極細ボーダー（黒が埋まった状態も視認しやすくする）
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(leftTrackX + 0.5, trackY + 0.5, trackW - 1, trackH - 1);
    ctx.strokeRect(rightTrackX + 0.5, trackY + 0.5, trackW - 1, trackH - 1);

    // 5. 上枠直下の「フック白点」（現在上段フロートバーに吊られている各ゼリーのX位置と同期）
    if (composites && composites.length > 0) {
        const dotY = topBarH + 5;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        for (let i = 0; i < composites.length; i++) {
            const comp = composites[i];
            if (!comp || comp.label !== 'jelly_composite' || !comp.isFloating || comp.isMerging) continue;
            const cx = comp.centroid ? comp.centroid.x : null;
            if (cx === null || !isFinite(cx)) continue;

            ctx.beginPath();
            ctx.arc(cx, dotY, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

// ==========================================
// サブ関数 2：内壁厳密クリップ半円バンパー ＆ フレーム内「幅 5px 角丸赤点灯サイドバー」
// ==========================================
function drawBumpersAndLedBars(ctx, bumperState) {
    if (!bumperState) return;

    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;
    const innerLeft = frameW;
    const innerRight = GAME_WIDTH - frameW;
    const innerTop = topBarH;
    const innerBottom = GAME_HEIGHT - frameW;

    const drawHalfCircleBumperAndLed = (bumper, isPressed, pushRatio, isLeft) => {
        if (!bumper) return;

        const bw = bumper.bounds.max.x - bumper.bounds.min.x;
        const bh = bumper.bounds.max.y - bumper.bounds.min.y;
        const cy = (bumper.bounds.min.y + bumper.bounds.max.y) * 0.5;
        const radiusY = bh * 0.5;
        const radiusX = bw;
        const baseX = isLeft ? bumper.bounds.min.x : bumper.bounds.max.x;
        const startAngle = isLeft ? (-Math.PI * 0.5) : (Math.PI * 0.5);
        const endAngle = isLeft ? (Math.PI * 0.5) : (Math.PI * 1.5);
        const clampedRatio = Math.max(0, Math.min(1, (pushRatio !== undefined) ? pushRatio : (isPressed ? 1 : 0)));

        // (A) 内壁矩形で厳密クリップされた半円（かまぼこ型）バンパー本体
        // 押し込まれると一体グレー外枠フレームの奥へ自然に沈み込む
        ctx.save();
        ctx.beginPath();
        ctx.rect(innerLeft, innerTop, innerRight - innerLeft, innerBottom - innerTop);
        ctx.clip();

        if (isPressed) {
            ctx.beginPath();
            ctx.ellipse(baseX, cy, radiusX + 3, radiusY + 3, 0, startAngle, endAngle, false);
            ctx.closePath();
            ctx.strokeStyle = 'rgba(255, 30, 70, 0.42)';
            ctx.lineWidth = 8;
            ctx.stroke();
        }

        ctx.fillStyle = isPressed ? '#ff1e46' : '#4a4e57';
        ctx.strokeStyle = isPressed ? '#ff6b81' : '#6c727f';
        ctx.lineWidth = 2;

        ctx.beginPath();
        ctx.ellipse(baseX, cy, radiusX, radiusY, 0, startAngle, endAngle, false);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // (B) 本家準拠：左右外枠フレーム内のボタン真脇「幅 5px 角丸赤点灯サイドバー」
        const ledW = 5;
        const ledX = isLeft ? ((frameW - ledW) * 0.5) : (GAME_WIDTH - frameW + (frameW - ledW) * 0.5);
        const ledTop = bumper.bounds.min.y + 3;
        const ledH = Math.max(16, bh - 6);
        const ledRadius = ledW * 0.5;

        // 未押下スロット溝（フレームに埋め込まれた暗いスリット）
        traceRoundedRect(ctx, ledX, ledTop, ledW, ledH, ledRadius);
        ctx.fillStyle = '#14161a';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 0.8;
        ctx.stroke();

        // 押し込み率に応じて中央から上下へ赤サイドバーがアナログ伸長し、ON（押し込み確定）時は真っ赤全点灯＋赤グロウ
        if (clampedRatio > 0.03 || isPressed) {
            const activeRatio = isPressed ? 1.0 : clampedRatio;
            const activeH = Math.max(ledW, ledH * activeRatio);
            const activeY = cy - activeH * 0.5;

            if (isPressed) {
                // 高負荷な shadowBlur を使わない軽量赤グロウ演出
                traceRoundedRect(ctx, ledX - 2, activeY - 3, ledW + 4, activeH + 6, ledRadius + 2);
                ctx.fillStyle = 'rgba(255, 30, 70, 0.36)';
                ctx.fill();
            }

            traceRoundedRect(ctx, ledX, activeY, ledW, activeH, ledRadius);
            ctx.fillStyle = isPressed ? '#ff1e46' : 'rgba(255, 42, 75, 0.85)';
            ctx.fill();
        }
    };

    drawHalfCircleBumperAndLed(
        bumperState.leftBumper,
        bumperState.leftPressed,
        bumperState.leftPushRatio,
        true
    );
    drawHalfCircleBumperAndLed(
        bumperState.rightBumper,
        bumperState.rightPressed,
        bumperState.rightPushRatio,
        false
    );
}

// ==========================================
// サブ関数 3：ソフトボディ（幾何外向き法線・収縮補正密着スムージング・ホップ最前面ポップアップ・合体真っ白フラッシュ）
// ==========================================
function drawSingleSoftBody(ctx, comp, gameState, renderMeta, deferText = false, composites = null, compIndex = -1) {
    let particles = comp.particles || null;
    if (!particles) {
        particles = [];
        for (let j = 0; j < comp.bodies.length; j++) {
            const b = comp.bodies[j];
            if (b.label === 'jelly_particle') particles.push(b);
        }
    }

    if (particles.length < 3) return;

    const jellyValue = comp.jellyValue || particles[0].jellyValue || 1;
    const config = JELLY_CONFIG[jellyValue] || JELLY_CONFIG[32768] || JELLY_CONFIG[16384] || JELLY_CONFIG[8192];
    const n = particles.length;
    const beadRatio = PHYSICS.BEAD_RADIUS_RATIO || 0.18;
    const pRadius = comp.particleRadius || (config.radius * beadRatio);

    // スムージング＋二次ベジェ曲線による内向き収縮を微補正し、隣同士が隙間なくフラット密着する本家ルックへ調整
    const visualOuterRadius = pRadius + Math.min(1.6, 0.7 + pRadius * 0.12);

    ensureOuterPointsCapacity(n);

    // 1. 重心の算出
    let cx = 0;
    let cy = 0;
    for (let j = 0; j < n; j++) {
        cx += particles[j].position.x;
        cy += particles[j].position.y;
    }
    cx /= n;
    cy /= n;

    // 2. 各パーティクルの「外側のフチ（外縁）」座標を事前確保バッファへ算出 ＆ 最小半径計測
    let minRadialDist = Infinity;
    for (let j = 0; j < n; j++) {
        const pPrev = particles[(j - 1 + n) % n].position;
        const pCurr = particles[j].position;
        const pNext = particles[(j + 1) % n].position;

        const dx = pCurr.x - cx;
        const dy = pCurr.y - cy;
        const dLen = Math.sqrt(dx * dx + dy * dy);
        if (dLen < minRadialDist) {
            minRadialDist = dLen;
        }

        let radialX = 0;
        let radialY = 0;
        if (dLen > 0.0001) {
            radialX = dx / dLen;
            radialY = dy / dLen;
        } else {
            const fallbackAngle = (comp.avgAngle || 0) + (j / n) * Math.PI * 2;
            radialX = Math.cos(fallbackAngle);
            radialY = Math.sin(fallbackAngle);
        }

        // 時計回り閉曲線の幾何学的外向き法線 (ty, -tx) を一貫採用（凹み変形時のトゲ・めくれ込み描画を根絶）
        const tx = pNext.x - pPrev.x;
        const ty = pNext.y - pPrev.y;
        const tLen = Math.sqrt(tx * tx + ty * ty);

        let nx = radialX;
        let ny = radialY;
        if (tLen > 0.0001) {
            nx = ty / tLen;
            ny = -tx / tLen;
        }

        const outPt = outerPointsBuffer[j];
        outPt.x = pCurr.x + nx * visualOuterRadius;
        outPt.y = pCurr.y + ny * visualOuterRadius;
    }

    // 3. 細密ビーズ＋液体変形の美しい密着輪郭向け 描画専用1パス軽量スムージング（0.15 / 0.70 / 0.15）
    // 物理座標へ一切触れず、角丸多角形の密着エッジを保ちながら微細なガタつきのみ滑らかに除去する
    for (let j = 0; j < n; j++) {
        const prevPt = outerPointsBuffer[(j - 1 + n) % n];
        const currPt = outerPointsBuffer[j];
        const nextPt = outerPointsBuffer[(j + 1) % n];
        const smPt = smoothedPointsBuffer[j];
        smPt.x = prevPt.x * 0.15 + currPt.x * 0.70 + nextPt.x * 0.15;
        smPt.y = prevPt.y * 0.15 + currPt.y * 0.70 + nextPt.y * 0.15;
    }

    // 4. 2.5Dホップ立体ポップアップスケールの計算
    // （合体時の膨張成長は softbody.js の物理 Ease-Out-Back Grow-In に一本化し、二重膨張・不要膨張を根絶）
    let scale = 1.0;
    const now = renderMeta.now;

    const isHopping = Boolean(comp.isBarHopping);
    let hopLiftRatio = 0;
    if (isHopping) {
        const maxPopScale = FLOAT_BAR.HOP_POPUP_MAX_SCALE || 1.14;
        const liftPx = Math.max(0, FLOAT_BAR.Y - cy);
        hopLiftRatio = Math.max(0.18, Math.min(1, liftPx / 72));
        scale *= (1.0 + hopLiftRatio * (maxPopScale - 1.0));
    }

    // 選択中／共鳴ハイライトの判定
    const isSelected = Boolean(
        comp.isFloating &&
        (
            (gameState.selectedJelly && gameState.selectedJelly === comp) ||
            (gameState.selectedJellyId && comp.jellyId === gameState.selectedJellyId)
        )
    );

    const isResonanceMatch = Boolean(
        renderMeta.isAiming &&
        !isSelected &&
        !comp.isMerging &&
        renderMeta.selectedMatchValue !== null &&
        jellyValue === renderMeta.selectedMatchValue
    );

    // 5. ホップ飛行中の立体ドロップシャドウ（高負荷な shadowBlur 不使用・軽量シルエット方式）
    if (isHopping) {
        const shadowOffsetY = 6 + hopLiftRatio * 10;
        ctx.save();
        ctx.translate(cx, cy + shadowOffsetY);
        ctx.scale(scale * 0.96, scale * 0.96);
        ctx.translate(-cx, -cy);
        traceSmoothBlobPath(ctx, smoothedPointsBuffer, n);
        ctx.fillStyle = `rgba(0, 0, 0, ${(0.28 + hopLiftRatio * 0.18).toFixed(3)})`;
        ctx.fill();
        ctx.restore();
    }

    // 6. スライム本体の描画（黒枠先行 stroke → ビビッド色 fill で黒潰れ完全防止）
    // 通常ゼリー（scale === 1.0）では不要な ctx.save / translate / scale / restore を省略して描画負荷を削減
    const needsBodyTransform = (scale !== 1.0);
    if (needsBodyTransform) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
    }

    traceSmoothBlobPath(ctx, smoothedPointsBuffer, n);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (isSelected) {
        // 本家準拠：選択中の上段ゼリーのみ外側にクッキリした太い白枠
        ctx.lineWidth = 10;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
    } else {
        // ドラッグ中の同数字「共鳴ハイライト」：外枠が控えめに白く脈動
        if (isResonanceMatch) {
            ctx.lineWidth = renderMeta.resonanceLineWidth;
            ctx.strokeStyle = `rgba(255, 255, 255, ${renderMeta.resonanceAlpha})`;
            ctx.stroke();
        }
        // 非選択上段の濁り白枠は廃止し、全ゼリー共通で均一・鮮明な黒境界線を描画
        ctx.lineWidth = 5;
        ctx.strokeStyle = renderMeta.outlineColor;
        ctx.stroke();
    }

    // 内側をフラットなビビッドカラーで塗り潰す
    ctx.fillStyle = config.color;
    ctx.fill();

    // (A) 合体前の「吸い付きの間」予兆発光（mergePreGlowUntil 中にふわっと白く輝き、完全白へ滑らかに繋ぐ）
    if (comp.mergePreGlowUntil && now < comp.mergePreGlowUntil) {
        const startT = comp.mergePreGlowStart || (comp.mergePreGlowUntil - 80);
        const span = Math.max(1, comp.mergePreGlowUntil - startT);
        const prog = Math.max(0, Math.min(1, (now - startT) / span));
        const glowAlpha = 0.15 + prog * 0.43;
        ctx.fillStyle = `rgba(255, 255, 255, ${glowAlpha.toFixed(3)})`;
        ctx.fill();
    }

    // (B) 本家準拠「合体瞬間の真っ白フラッシュ」（保護時間 680〜1200ms と 1対1 完全同期）
    // 前半 30% は完全白（#ffffff）を保持し、後半 70% でコサイン減衰によりゆっくり本色へ溶け戻る
    if (comp.mergeFlashUntil && now < comp.mergeFlashUntil) {
        const flashStart = comp.mergeFlashStart || comp.createdAt || (comp.mergeFlashUntil - 680);
        const totalFlash = Math.max(1, comp.mergeFlashUntil - flashStart);
        const progress = Math.max(0, Math.min(1, (now - flashStart) / totalFlash));
        const whiteHoldRatio = (EFFECTS.MERGE_WHITE_HOLD_RATIO !== undefined) ? EFFECTS.MERGE_WHITE_HOLD_RATIO : 0.30;

        if (progress <= whiteHoldRatio) {
            ctx.fillStyle = '#ffffff';
            ctx.fill();
        } else {
            const fadeT = Math.max(0, Math.min(1, (progress - whiteHoldRatio) / Math.max(0.01, 1 - whiteHoldRatio)));
            const whiteAlpha = Math.cos(fadeT * Math.PI * 0.5);
            if (whiteAlpha > 0.005) {
                ctx.fillStyle = `rgba(255, 255, 255, ${whiteAlpha.toFixed(3)})`;
                ctx.fill();
            }
        }
    }

    if (needsBodyTransform) {
        ctx.restore();
    }

    // 7. 数字の位置・サイズ算出（下段限定最大内接円探索 ＋ 位置・角度・サイズのデッドゾーン＆ローパス補間）
    // 真っ白フラッシュ中も太字黒文字（コントラスト比 21:1）をそのまま維持して描画
    let targetTextX = cx;
    let targetTextY = cy;
    let effectiveThickness = minRadialDist + pRadius;

    // 外縁ポリゴンの実面積から面積等価半径（sqrt(area / pi)）を算出（細長く潰れた際の過度な文字縮小を防止）
    let signedOuterArea = 0;
    for (let j = 0; j < n; j++) {
        const p1 = smoothedPointsBuffer[j];
        const p2 = smoothedPointsBuffer[(j + 1) % n];
        signedOuterArea += (p1.x * p2.y - p2.x * p1.y);
    }
    const outerArea = Math.abs(signedOuterArea) * 0.5;
    const equivalentRadius = Math.sqrt(Math.max(1, outerArea) / Math.PI);

    // 上段待機・ホップ中は横長カプセルでの誤移動を防ぐため探索をスキップし重心中央を維持
    // 下段ゼリー限定で重心がポリゴン外、または重心付近が狭い（< 0.58 * equivalentRadius）場合に最大内接円中心を探索
    // 重心相対オフセットをキャッシュして 3 フレーム均等分散間引きすることで高速落下時の追従ズレ 0px と終盤負荷削減を両立
    // ゲームオーバー静止中は初回キャッシュ生成を保証しつつ再探索をスキップして省電力化
    if (!comp.isFloating && !isHopping) {
        const safeCompIdx = (compIndex >= 0) ? compIndex : 0;
        const frameCount = (gameState && gameState.frameCount) ? gameState.frameCount : 0;
        const isGameOver = Boolean(gameState && gameState.isGameOver);
        const shouldRefreshTextSearch = (comp._cachedTextOffsetX === undefined) ||
            (!isGameOver && (((frameCount + safeCompIdx) % 3) === 0));

        if (shouldRefreshTextSearch) {
            let cachedThickness = -1;
            const centroidInside = isPointInsidePolygon(cx, cy, smoothedPointsBuffer, n);
            const centroidClearanceSq = centroidInside
                ? computeMinEdgeDistSq(cx, cy, smoothedPointsBuffer, n)
                : 0;
            const narrowThresh = equivalentRadius * 0.58;

            if (!centroidInside || centroidClearanceSq < narrowThresh * narrowThresh) {
                const halfN = Math.floor(n / 2);
                let bestX = cx;
                let bestY = cy;
                let bestClearSq = -1;
                let bestCentDistSq = Infinity;
                let foundInside = false;

                // 候補(a)：重複排除済みの対角中点（0 〜 halfN - 1）
                for (let j = 0; j < halfN; j++) {
                    const pA = particles[j].position;
                    const pB = particles[j + halfN].position;
                    const mx = (pA.x + pB.x) * 0.5;
                    const my = (pA.y + pB.y) * 0.5;
                    if (!isPointInsidePolygon(mx, my, smoothedPointsBuffer, n)) continue;

                    const clearSq = computeMinEdgeDistSq(mx, my, smoothedPointsBuffer, n);
                    const ddx = mx - cx;
                    const ddy = my - cy;
                    const centDistSq = ddx * ddx + ddy * ddy;

                    if (clearSq > bestClearSq + 0.25 ||
                        (Math.abs(clearSq - bestClearSq) <= 0.25 && centDistSq < bestCentDistSq)) {
                        bestClearSq = clearSq;
                        bestCentDistSq = centDistSq;
                        bestX = mx;
                        bestY = my;
                        foundInside = true;
                    }
                }

                // 候補(b)：間引き頂点（step = 2）と重心の中点
                for (let j = 0; j < n; j += 2) {
                    const p = particles[j].position;
                    const mx = (p.x + cx) * 0.5;
                    const my = (p.y + cy) * 0.5;
                    if (!isPointInsidePolygon(mx, my, smoothedPointsBuffer, n)) continue;

                    const clearSq = computeMinEdgeDistSq(mx, my, smoothedPointsBuffer, n);
                    const ddx = mx - cx;
                    const ddy = my - cy;
                    const centDistSq = ddx * ddx + ddy * ddy;

                    if (clearSq > bestClearSq + 0.25 ||
                        (Math.abs(clearSq - bestClearSq) <= 0.25 && centDistSq < bestCentDistSq)) {
                        bestClearSq = clearSq;
                        bestCentDistSq = centDistSq;
                        bestX = mx;
                        bestY = my;
                        foundInside = true;
                    }
                }

                if (foundInside) {
                    // 重心がポリゴン内の場合は 1.18 倍（二乗 1.3924 倍）ヒステリシスを満たす場合のみ移動し振り子振動を防止
                    if (!centroidInside || bestClearSq > centroidClearanceSq * 1.3924) {
                        targetTextX = bestX;
                        targetTextY = bestY;
                        effectiveThickness = Math.sqrt(bestClearSq);
                        cachedThickness = effectiveThickness;
                    }
                } else if (!centroidInside) {
                    let nearestSq = Infinity;
                    for (let j = 0; j < n; j++) {
                        const p = particles[j].position;
                        const ddx = p.x - cx;
                        const ddy = p.y - cy;
                        const dSq = ddx * ddx + ddy * ddy;
                        if (dSq < nearestSq) {
                            nearestSq = dSq;
                            targetTextX = p.x;
                            targetTextY = p.y;
                        }
                    }
                    effectiveThickness = Math.min(effectiveThickness, pRadius * 1.4);
                    cachedThickness = effectiveThickness;
                }
            }

            comp._cachedTextOffsetX = targetTextX - cx;
            comp._cachedTextOffsetY = targetTextY - cy;
            comp._cachedTextThickness = cachedThickness;
        } else {
            targetTextX = cx + comp._cachedTextOffsetX;
            targetTextY = cy + comp._cachedTextOffsetY;
            if (comp._cachedTextThickness >= 0) {
                effectiveThickness = comp._cachedTextThickness;
            }
        }
    } else if (comp._cachedTextOffsetX !== undefined) {
        comp._cachedTextOffsetX = undefined;
        comp._cachedTextOffsetY = undefined;
        comp._cachedTextThickness = -1;
    }

    // (1) 文字位置の安定化：微小振動（< 0.45px）はピタッと固定、高速飛行・落下時は遅延ゼロ追従
    if (comp._renderTextX === undefined || comp._renderTextY === undefined) {
        comp._renderTextX = targetTextX;
        comp._renderTextY = targetTextY;
    } else {
        const dxText = targetTextX - comp._renderTextX;
        const dyText = targetTextY - comp._renderTextY;
        const distSqText = dxText * dxText + dyText * dyText;
        if (distSqText >= 0.2025) { // 0.45 * 0.45
            const posLerp = (distSqText > 9.0) ? 1.0 : 0.28;
            comp._renderTextX += dxText * posLerp;
            comp._renderTextY += dyText * posLerp;
        }
    }
    const textX = comp._renderTextX;
    const textY = comp._renderTextY;

    // (2) 文字角度の安定化：正弦写像（最大±30度）＋ 微小振動（< 0.025rad）デッドゾーン＆ローパス補間
    const rawAngle = comp.avgAngle || 0;
    const targetAngle = comp.isFloating ? (Math.sin(rawAngle) * 0.14) : (Math.sin(rawAngle) * 0.52);
    if (comp._renderTextAngle === undefined) {
        comp._renderTextAngle = targetAngle;
    } else {
        const angleDiff = targetAngle - comp._renderTextAngle;
        if (Math.abs(angleDiff) >= 0.025) {
            comp._renderTextAngle += angleDiff * 0.22;
        }
    }
    const displayAngle = comp._renderTextAngle;

    // (3) フォントサイズの算出＆安定化：短辺1点＋面積等価半径ブレンド・最小 11.5px 保証・微小振動（< 0.35px）固定
    const valueText = String(jellyValue);
    const digitScale = valueText.length >= 5 ? 0.58 : (valueText.length >= 4 ? 0.68 : (valueText.length >= 3 ? 0.82 : 1.0));
    // 上段横長カプセル時は縦半高を基準にバランス良く収める
    const refRadius = comp.isFloating
        ? Math.min(config.radius, (comp.capsuleHalfHeight || FLOAT_BAR.CHANNEL_HALF_HEIGHT || 26) * 1.15)
        : config.radius;
    const blendedThickness = effectiveThickness * 0.55 + equivalentRadius * 0.45;
    const baseFontSize = Math.max(11.5, refRadius * 0.62 * digitScale);
    const safeWidthLimit = Math.max(11.5, blendedThickness * 1.55 * digitScale);
    const targetFontSize = Math.max(11.5, Math.min(baseFontSize, safeWidthLimit));

    if (comp._renderFontSize === undefined) {
        comp._renderFontSize = targetFontSize;
    } else {
        const sizeDiff = targetFontSize - comp._renderFontSize;
        if (Math.abs(sizeDiff) >= 0.35) {
            comp._renderFontSize += sizeDiff * 0.22;
        }
    }
    const fontSize = comp._renderFontSize;

    const isMerged = Boolean(comp.hasMerged);
    const fillStyle = config.text || ACTIVE_THEME.text || '#000000';
    const textAlpha = isMerged ? 1.0 : renderMeta.unmergedAlpha;
    const fontStr = getCachedFontString(isMerged, fontSize);

    // 通常レイヤーは全本体描画後に最前面へまとめて描画するが、
    // 後続（手前）ゼリーの物理リング内部に覆われている数字だけは最前面へ透かさず即時描画する
    const shouldDeferText = deferText &&
        !(composites && compIndex >= 0 && isPointOccludedByFrontJellies(textX, textY, composites, compIndex + 1));

    if (shouldDeferText) {
        pushDeferredText(textX, textY, displayAngle, scale, valueText, fillStyle, textAlpha, fontStr);
    } else {
        drawJellyTextItem(ctx, textX, textY, displayAngle, scale, valueText, fillStyle, textAlpha, fontStr);
    }
}

function drawSoftBodies(ctx, composites, gameState) {
    if (!composites || composites.length === 0) return;

    // 60Hz / 120Hz ProMotion いずれでも一定リズムを保つ時間ベース定数角周波数（10.8 rad/s）
    const timeSec = performance.now() * 0.001;
    const pulseWave = 0.5 + 0.5 * Math.sin(timeSec * 10.8);
    const isAiming = Boolean(gameState.isDragging && !gameState.isGameOver && gameState.selectedJelly);

    const renderMeta = {
        now: Date.now(),
        outlineColor: ACTIVE_THEME.outline || '#000000',
        unmergedAlpha: (ACTIVE_THEME.unmergedTextAlpha !== undefined) ? ACTIVE_THEME.unmergedTextAlpha : 0.72,
        isAiming,
        selectedMatchValue: isAiming ? gameState.selectedJelly.jellyValue : null,
        resonanceAlpha: (0.35 + pulseWave * 0.50).toFixed(3),
        resonanceLineWidth: 8.5 + pulseWave * 2.5
    };

    // 1パス目：通常レイヤー（下段フィールド内 ＋ 上段待機中ゼリー）の全本体を描画し、非遮蔽の数字はバッファへ退避
    hoppingCompositesBuffer.length = 0;
    deferredTextCount = 0;
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (!comp || comp.label !== 'jelly_composite') continue;

        if (comp.isBarHopping) {
            hoppingCompositesBuffer.push(comp);
            continue;
        }
        drawSingleSoftBody(ctx, comp, gameState, renderMeta, true, composites, i);
    }

    // 2パス目：通常レイヤーの非遮蔽数字テキストを最前面へまとめて描画（大塊の黒枠・本体による小塊数字の上書き隠れを根絶）
    for (let i = 0; i < deferredTextCount; i++) {
        const item = deferredTextBuffer[i];
        drawJellyTextItem(ctx, item.x, item.y, item.angle, item.scale, item.valueText, item.fillStyle, item.alpha, item.font);
    }
    deferredTextCount = 0;

    // 3パス目：2.5D上段飛び越えホップ飛行中のゼリーを最前面レイヤーとして描画（影 → 本体 → 数字）
    for (let i = 0; i < hoppingCompositesBuffer.length; i++) {
        drawSingleSoftBody(ctx, hoppingCompositesBuffer[i], gameState, renderMeta, false);
    }
    hoppingCompositesBuffer.length = 0;
}

// ==========================================
// サブ関数 4：順方向ダイレクトエイム矢印（中心起点白丸＆強弱連動太矢印）・ホップ予測ドット・オフセットガイド
// ==========================================
function drawAimAndHopGuide(ctx, gameState) {
    if (!gameState || !gameState.isDragging || gameState.isGameOver) return;

    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;

    let originX = gameState.dragStartX;
    let originY = gameState.dragStartY;
    let selectedHalfH = 26;

    if (gameState.selectedJelly) {
        const sel = gameState.selectedJelly;
        selectedHalfH = sel.isFloating
            ? (sel.capsuleHalfHeight || Math.min(sel.targetRadius || 25.5, FLOAT_BAR.CHANNEL_HALF_HEIGHT || 26))
            : (sel.targetRadius || 25.5);

        if (sel.centroid) {
            originX = sel.centroid.x;
            originY = sel.centroid.y;
        } else if (sel.particles && sel.particles.length > 0) {
            const pts = sel.particles;
            let sx = 0;
            let sy = 0;
            for (let k = 0; k < pts.length; k++) {
                sx += pts[k].position.x;
                sy += pts[k].position.y;
            }
            originX = sx / pts.length;
            originY = sy / pts.length;
        }
    }

    const dx = gameState.dragVectorX;
    const dy = gameState.dragVectorY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 22;
    const hasDraggedOut = Boolean(gameState.hasDraggedOut);
    // aim.js の角度勾配付きホップ判定と完全一致させるため gameState.isHopAim へ一本化
    const isHopAim = Boolean(gameState.isHopAim);
    const darkOutlineColor = 'rgba(0, 0, 0, 0.72)';

    ctx.save();

    if (dist >= cancelRadius) {
        // (A) 上段飛び越えホップモード時：細い半透明黒縁取り付きの放物線予測ドット（6〜7点）＆着地リング
        if (isHopAim && Array.isArray(gameState.hopPreviewPoints) && gameState.hopPreviewPoints.length > 0) {
            const previewPts = gameState.hopPreviewPoints;
            const ptCount = previewPts.length;
            for (let k = 0; k < ptCount; k++) {
                const pt = previewPts[k];
                const t = (k + 1) / ptCount;
                const dotRadius = Math.max(2.2, 4.4 - t * 1.6);
                const dotAlpha = Math.max(0.28, 0.90 - t * 0.45);

                ctx.beginPath();
                ctx.arc(pt.x, pt.y, dotRadius + 1.2, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(0, 0, 0, ${(dotAlpha * 0.72).toFixed(3)})`;
                ctx.fill();

                ctx.beginPath();
                ctx.arc(pt.x, pt.y, dotRadius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(34, 211, 238, ${dotAlpha.toFixed(3)})`;
                ctx.fill();
            }

            const lastPt = previewPts[ptCount - 1];
            ctx.beginPath();
            ctx.arc(lastPt.x, lastPt.y, 7.5, 0, Math.PI * 2);
            ctx.strokeStyle = darkOutlineColor;
            ctx.lineWidth = 4.4;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(lastPt.x, lastPt.y, 7.5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(34, 211, 238, 0.72)';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // (B) 控えめなキャンセルエリア円
        ctx.beginPath();
        ctx.arc(originX, originY, cancelRadius, 0, Math.PI * 2);
        ctx.fillStyle = isHopAim ? 'rgba(34, 211, 238, 0.16)' : 'rgba(255, 255, 255, 0.16)';
        ctx.fill();

        // (C) 本家準拠：中心起点丸 ＋ 順方向実線矢印（同色ゼリー上の同化を防ぐ細い半透明黒縁取り先行描画）
        // ホップ時は従来のシアン固定、通常ショット時は引き量に応じた弱〜中（白）→下方向パワー帯（ゴールド→アンバーオレンジ）へ連続変化
        let arrowColor = '#22d3ee';
        let ringRadius = 9.5;
        let shaftWidth = 6;
        let headLen = 19;

        if (!isHopAim) {
            const baseMaxDrag = Math.max(cancelRadius + 1, PHYSICS.AIM_MAX_DRAG || 120);
            const downMaxDrag = Math.max(baseMaxDrag + 1, PHYSICS.AIM_MAX_DRAG_DOWN || 170);
            const baseT = Math.max(0, Math.min(1, (dist - cancelRadius) / (baseMaxDrag - cancelRadius)));
            const powerT = Math.max(0, Math.min(1, (dist - baseMaxDrag) / (downMaxDrag - baseMaxDrag)));

            ringRadius = 8.5 + 1.0 * baseT + 1.0 * powerT;
            shaftWidth = 4.6 + 1.4 * baseT + 2.0 * powerT;
            headLen = 15 + 4 * baseT + 5 * powerT;

            if (powerT <= 0) {
                const alpha = 0.80 + 0.20 * baseT;
                arrowColor = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
            } else if (powerT <= 0.5) {
                // #ffffff (255, 255, 255) → #fde047 (253, 224, 71)
                const u = powerT * 2;
                const r = Math.round(255 + (253 - 255) * u);
                const g = Math.round(255 + (224 - 255) * u);
                const b = Math.round(255 + (71 - 255) * u);
                arrowColor = `rgb(${r}, ${g}, ${b})`;
            } else {
                // #fde047 (253, 224, 71) → #fb923c (251, 146, 60)
                const u = (powerT - 0.5) * 2;
                const r = Math.round(253 + (251 - 253) * u);
                const g = Math.round(224 + (146 - 224) * u);
                const b = Math.round(71 + (60 - 71) * u);
                arrowColor = `rgb(${r}, ${g}, ${b})`;
            }
        }

        const endX = originX + dx;
        const endY = originY + dy;
        const angle = Math.atan2(dy, dx);
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const shaftStartX = originX + cosA * 8;
        const shaftStartY = originY + sinA * 8;
        const shaftEndX = endX - cosA * (headLen * 0.55);
        const shaftEndY = endY - sinA * (headLen * 0.55);
        const headLeftX = endX - headLen * Math.cos(angle - Math.PI / 6);
        const headLeftY = endY - headLen * Math.sin(angle - Math.PI / 6);
        const headRightX = endX - headLen * Math.cos(angle + Math.PI / 6);
        const headRightY = endY - headLen * Math.sin(angle + Math.PI / 6);

        // 先行パス：細い半透明黒縁取り（起点リング → 軸 → 先端ヘッドの順に描画し接合部の黒割り込みを防止）
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = darkOutlineColor;

        ctx.beginPath();
        ctx.arc(originX, originY, ringRadius, 0, Math.PI * 2);
        ctx.lineWidth = 5.6;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(shaftStartX, shaftStartY);
        ctx.lineTo(shaftEndX, shaftEndY);
        ctx.lineWidth = shaftWidth + 2.6;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(headLeftX, headLeftY);
        ctx.lineTo(headRightX, headRightY);
        ctx.closePath();
        ctx.lineWidth = 2.8;
        ctx.stroke();

        // 本体パス：中心起点リング（本家実機画像の起点丸表現）
        ctx.beginPath();
        ctx.arc(originX, originY, ringRadius, 0, Math.PI * 2);
        ctx.strokeStyle = arrowColor;
        ctx.lineWidth = 3;
        ctx.stroke();

        // 本体パス：矢印の軸（強弱連動の実線）
        ctx.beginPath();
        ctx.moveTo(shaftStartX, shaftStartY);
        ctx.lineTo(shaftEndX, shaftEndY);
        ctx.strokeStyle = arrowColor;
        ctx.lineWidth = shaftWidth;
        ctx.lineCap = 'round';
        ctx.stroke();

        // 本体パス：矢印の先端（クッキリした三角ヘッド）
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(headLeftX, headLeftY);
        ctx.lineTo(headRightX, headRightY);
        ctx.closePath();
        ctx.fillStyle = arrowColor;
        ctx.fill();
    } else if (hasDraggedOut) {
        // 一度外へ伸ばしてから中心へ戻した状態：指に隠れないオフセット型キャンセル視覚ガイド
        ctx.beginPath();
        ctx.arc(originX, originY, Math.max(cancelRadius, selectedHalfH + 6), 0, Math.PI * 2);
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
        ctx.stroke();
        ctx.setLineDash([]);

        const badgeX = Math.max(frameW + 14, Math.min(GAME_WIDTH - frameW - 14, originX));
        const badgeY = Math.max(topBarH + 16, originY - selectedHalfH - 22);

        ctx.beginPath();
        ctx.arc(badgeX, badgeY, 12, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.stroke();

        const crossR = 4.5;
        ctx.beginPath();
        ctx.moveTo(badgeX - crossR, badgeY - crossR);
        ctx.lineTo(badgeX + crossR, badgeY + crossR);
        ctx.moveTo(badgeX + crossR, badgeY - crossR);
        ctx.lineTo(badgeX - crossR, badgeY + crossR);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.stroke();
    } else {
        // タップしてまだ外へドラッグしていない状態：指に隠れないオフセット型「そっと落とし」視覚ガイド
        ctx.beginPath();
        ctx.arc(originX, originY, selectedHalfH + 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();

        const dropBaseY = originY + selectedHalfH + 16;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.90)';
        ctx.lineWidth = 2.6;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(originX - 7, dropBaseY - 4);
        ctx.lineTo(originX, dropBaseY + 3);
        ctx.lineTo(originX + 7, dropBaseY - 4);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.50)';
        ctx.beginPath();
        ctx.moveTo(originX - 5, dropBaseY + 4);
        ctx.lineTo(originX, dropBaseY + 9);
        ctx.lineTo(originX + 5, dropBaseY + 4);
        ctx.stroke();
    }

    ctx.restore();
}

// ==========================================
// サブ関数 5：バンパー押し込み時の警告オーバーレイ（時間ベース定数角周波数 ＆ bothPressedRatio 連動切迫演出 ＆ ゲームオーバー余韻静止保持）
// ==========================================
function drawWarningOverlay(ctx, gameState, bumperState) {
    if (!bumperState || !gameState) return;
    const isGameOver = Boolean(gameState.isGameOver);
    const bothPressed = Boolean(bumperState.leftPressed && bumperState.rightPressed);
    const anyPressed = Boolean(bumperState.leftPressed || bumperState.rightPressed);
    const bothPressedRatio = Math.max(0, Math.min(1, Number(bumperState.bothPressedRatio) || 0));
    if (!anyPressed && bothPressedRatio <= 0.05) return;

    // 60Hz / 120Hz ProMotion いずれでも一定リズムを保つ時間ベース定数角周波数（片側 5.4 / 両側 13.2 rad/s）
    // ゲームオーバー余韻中は点滅を止め、静かな赤ティント（0.12）と内壁赤ボーダー（固定アルファ 0.75）を保持
    const timeSec = isGameOver ? 0 : (performance.now() * 0.001);
    const urgentPulse = isGameOver ? 1 : Math.abs(Math.sin(timeSec * 13.2));

    // (A) 画面赤フラッシュ（片側は穏やか、両側同時押込時は bothPressedRatio に連動して濃度上昇、ゲームオーバー余韻中は 0.12 固定）
    if (anyPressed || isGameOver) {
        const flashAlpha = isGameOver
            ? 0.12
            : (bothPressed
                ? (urgentPulse * (0.14 + bothPressedRatio * 0.12) + bothPressedRatio * 0.06)
                : (Math.abs(Math.sin(timeSec * 5.4)) * 0.075));
        ctx.fillStyle = `rgba(255, 71, 87, ${flashAlpha.toFixed(3)})`;
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }

    // (B) 両側同時押込の切迫感を示す内壁赤ボーダーグロウ（内壁クリップで外枠・LEDと 0.000px 重なりなし・ゲームオーバー余韻中は固定アルファ 0.75 保持）
    if (bothPressedRatio > 0.05) {
        const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
        const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;
        const cut = CONTAINER.CORNER_CUT_SIZE;
        const innerLeft = frameW;
        const innerRight = GAME_WIDTH - frameW;
        const innerTop = topBarH;
        const innerBottom = GAME_HEIGHT - frameW;

        let borderAlpha;
        if (isGameOver) {
            borderAlpha = 0.75;
        } else {
            const fadeFactor = Math.max(0, Math.min(1, (bothPressedRatio - 0.05) / 0.95));
            const borderPulse = 0.72 + 0.28 * urgentPulse;
            borderAlpha = fadeFactor * (0.35 + 0.55 * bothPressedRatio) * borderPulse;
        }

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(innerLeft, innerTop);
        ctx.lineTo(innerLeft, innerBottom - cut);
        ctx.lineTo(innerLeft + cut, innerBottom);
        ctx.lineTo(innerRight - cut, innerBottom);
        ctx.lineTo(innerRight, innerBottom - cut);
        ctx.lineTo(innerRight, innerTop);
        ctx.closePath();
        ctx.clip();

        ctx.strokeStyle = `rgba(255, 30, 70, ${borderAlpha.toFixed(3)})`;
        ctx.lineWidth = 4 + bothPressedRatio * 8;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.restore();
    }
}

/**
 * 毎フレーム呼ばれるメインの描画処理
 * @param {CanvasRenderingContext2D} ctx - 描画先のCanvasコンテキスト
 * @param {Object} world - Matter.jsの物理世界
 * @param {Object} gameState - 現在のゲーム状態
 * @param {Object} bumperState - バンパーの状態と実体 (leftBumper, rightBumper, leftPressed, rightPressed, leftPushRatio, rightPushRatio, bothPressedRatio)
 */
export function renderGame(ctx, world, gameState, bumperState) {
    // 0. Retina（DPR）高精細解像度対応：実Canvas解像度と論理サイズ（GAME_WIDTH x GAME_HEIGHT）を自動同期
    const canvas = ctx.canvas;
    const dprScaleX = (canvas && canvas.width > 0) ? (canvas.width / GAME_WIDTH) : 1;
    const dprScaleY = (canvas && canvas.height > 0) ? (canvas.height / GAME_HEIGHT) : 1;

    ctx.save();
    ctx.setTransform(dprScaleX, 0, 0, dprScaleY, 0, 0);

    // 毎フレームの配列新規生成を避けるため world.composites を直接参照
    const composites = (world && world.composites) ? world.composites : Matter.Composite.allComposites(world);

    // 1. 背景・一体グレー外枠フレーム・内壁基準45度角カット・上枠スポーナー黒ゲージ＆フック白点
    drawContainerAndTopBar(ctx, composites, gameState);

    // 2. 内壁厳密クリップ半円バンパー ＆ フレーム内「幅 5px 角丸赤点灯サイドバー」
    drawBumpersAndLedBars(ctx, bumperState);

    // 3. ソフトボディ本体（通常レイヤー全本体 → 通常レイヤー非遮蔽数字最前面 → ホップ最前面レイヤー）
    drawSoftBodies(ctx, composites, gameState);

    // 4. 順方向ダイレクトエイム矢印・ホップ予測ドット・オフセットガイド
    drawAimAndHopGuide(ctx, gameState);

    // 5. 警告エフェクト
    drawWarningOverlay(ctx, gameState, bumperState);

    ctx.restore();
}