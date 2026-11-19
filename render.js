/**
 * render.js
 * @version v7.0 (Fluid Normal Fix, Shrink Compensation, Grow-In Unification & Text Lerp - Phase 8)
 * @changes
 *   - 凹み変形時の「外向き法線反転バグ」を根絶するため、外縁座標算出の重心方向（radial）内積フォールバックを撤廃し、softbody.js と同じ時計回り閉曲線の幾何学的外向き法線 (ty, -tx) へ統一
 *   - 描画専用スムージング＋二次ベジェ曲線による輪郭の内向き収縮を微補正し、水風船同士が隙間なくフラットに押し付け合う本家準拠の密着感へ改善
 *   - 物理の Ease-Out-Back Grow-In との二重膨張（1.21倍）および新規スポーン時の不要膨張を解消するため、描画側の createdAt ベース膨張スケールを撤廃（2.5Dホップ時の立体ポップアップのみ維持）
 *   - 大きく潰れた際の数字テレポート振動を根絶するため、重心からの相対オフセットに対する軽量時間補間（lerp）を導入（高速飛行・落下時も遅延ゼロで追従）
 *   - GRAVITYキャッシュ不整合対策として constants.js / overlap_solver.js の絶対パスを ?v=7 へ統一
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
// ゼロアロケーション（毎フレームGC負荷削減）用事前確保バッファ
// ==========================================
const INITIAL_OUTER_POINTS_CAPACITY = 48;
const outerPointsBuffer = Array.from({ length: INITIAL_OUTER_POINTS_CAPACITY }, () => ({ x: 0, y: 0 }));
const smoothedPointsBuffer = Array.from({ length: INITIAL_OUTER_POINTS_CAPACITY }, () => ({ x: 0, y: 0 }));
const hoppingCompositesBuffer = [];

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
function drawSingleSoftBody(ctx, comp, gameState, renderMeta) {
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
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

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

    // (A) 合体前の「吸い付きの間」予兆発光（mergePreGlowUntil 中にふわっと白く輝く）
    if (comp.mergePreGlowUntil && now < comp.mergePreGlowUntil) {
        const startT = comp.mergePreGlowStart || (comp.mergePreGlowUntil - 60);
        const span = Math.max(1, comp.mergePreGlowUntil - startT);
        const prog = Math.max(0, Math.min(1, (now - startT) / span));
        const glowAlpha = 0.12 + prog * 0.36;
        ctx.fillStyle = `rgba(255, 255, 255, ${glowAlpha.toFixed(3)})`;
        ctx.fill();
    }

    // (B) 本家準拠「合体瞬間の真っ白フラッシュ」（保護時間 140〜300ms と 1対1 完全同期）
    // 前半 42% は完全白（#ffffff）を保持し、後半 58% で本色へ滑らかにフェードバックする
    if (comp.mergeFlashUntil && now < comp.mergeFlashUntil) {
        const flashStart = comp.mergeFlashStart || comp.createdAt || (comp.mergeFlashUntil - 160);
        const totalFlash = Math.max(1, comp.mergeFlashUntil - flashStart);
        const progress = Math.max(0, Math.min(1, (now - flashStart) / totalFlash));
        const whiteHoldRatio = (EFFECTS.MERGE_WHITE_HOLD_RATIO !== undefined) ? EFFECTS.MERGE_WHITE_HOLD_RATIO : 0.42;

        if (progress <= whiteHoldRatio) {
            ctx.fillStyle = '#ffffff';
            ctx.fill();
        } else {
            const fadeT = Math.max(0, Math.min(1, (progress - whiteHoldRatio) / Math.max(0.01, 1 - whiteHoldRatio)));
            const whiteAlpha = Math.pow(1 - fadeT, 1.45);
            if (whiteAlpha > 0.005) {
                ctx.fillStyle = `rgba(255, 255, 255, ${whiteAlpha.toFixed(3)})`;
                ctx.fill();
            }
        }
    }

    ctx.restore();

    // 7. 数字の描画（ポリゴン内安全位置補正 ＋ 重心相対オフセットの軽量時間補間でテレポート振動を根絶）
    // 真っ白フラッシュ中も太字黒文字（コントラスト比 21:1）をそのまま維持して描画
    let targetTextX = cx;
    let targetTextY = cy;
    let effectiveThickness = minRadialDist + pRadius;

    if (!isPointInsidePolygon(targetTextX, targetTextY, smoothedPointsBuffer, n)) {
        let bestDistSq = Infinity;
        const halfN = Math.floor(n / 2);
        let foundInside = false;

        for (let j = 0; j < n; j++) {
            const pA = particles[j].position;
            const pB = particles[(j + halfN) % n].position;
            const mx = (pA.x + pB.x) * 0.5;
            const my = (pA.y + pB.y) * 0.5;
            if (isPointInsidePolygon(mx, my, smoothedPointsBuffer, n)) {
                const ddx = mx - cx;
                const ddy = my - cy;
                const dSq = ddx * ddx + ddy * ddy;
                if (dSq < bestDistSq) {
                    bestDistSq = dSq;
                    targetTextX = mx;
                    targetTextY = my;
                    foundInside = true;
                }
            }
        }

        if (!foundInside) {
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
        } else {
            let correctedMin = Infinity;
            for (let j = 0; j < n; j++) {
                const ox = smoothedPointsBuffer[j].x - targetTextX;
                const oy = smoothedPointsBuffer[j].y - targetTextY;
                const d = Math.sqrt(ox * ox + oy * oy);
                if (d < correctedMin) correctedMin = d;
            }
            effectiveThickness = Math.min(effectiveThickness, correctedMin);
        }
    }

    // 重心からの相対オフセットのみを軽量補間（高速飛行・落下時は重心に0フレーム遅延追従しつつ境界振動のみ平滑化）
    const targetOffsetX = targetTextX - cx;
    const targetOffsetY = targetTextY - cy;
    if (comp._textOffsetX === undefined || comp._textOffsetY === undefined) {
        comp._textOffsetX = targetOffsetX;
        comp._textOffsetY = targetOffsetY;
    } else {
        const textLerp = 0.22;
        comp._textOffsetX += (targetOffsetX - comp._textOffsetX) * textLerp;
        comp._textOffsetY += (targetOffsetY - comp._textOffsetY) * textLerp;
    }

    const textX = cx + comp._textOffsetX;
    const textY = cy + comp._textOffsetY;

    // 穏やかな数字回転追従（正弦写像により360度回転時も不連続なく、上下逆さまにならない最大±30度へ収める）
    const rawAngle = comp.avgAngle || 0;
    const displayAngle = comp.isFloating ? (Math.sin(rawAngle) * 0.14) : (Math.sin(rawAngle) * 0.52);

    ctx.save();
    ctx.translate(textX, textY);
    ctx.rotate(displayAngle);
    ctx.scale(scale, scale);

    const valueText = String(jellyValue);
    const digitScale = valueText.length >= 5 ? 0.58 : (valueText.length >= 4 ? 0.68 : (valueText.length >= 3 ? 0.82 : 1.0));
    // 上段横長カプセル時は縦半高を基準にバランス良く収める
    const refRadius = comp.isFloating
        ? Math.min(config.radius, (comp.capsuleHalfHeight || FLOAT_BAR.CHANNEL_HALF_HEIGHT || 22) * 1.15)
        : config.radius;
    const baseFontSize = Math.max(12, refRadius * 0.62 * digitScale);
    const safeWidthLimit = Math.max(9, effectiveThickness * 1.55 * digitScale);
    const fontSize = Math.min(baseFontSize, safeWidthLimit);
    const isMerged = Boolean(comp.hasMerged);

    // 本家完全準拠：未合体は細字・薄色（スコア未加算）、合体済みは太字・濃色（スコア加算済み）
    ctx.fillStyle = config.text || ACTIVE_THEME.text || '#000000';
    ctx.globalAlpha = isMerged ? 1.0 : renderMeta.unmergedAlpha;
    ctx.font = `${isMerged ? '900' : '400'} ${fontSize.toFixed(1)}px "Courier New", Courier, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(valueText, 0, 0);
    ctx.restore();
}

function drawSoftBodies(ctx, composites, gameState) {
    if (!composites || composites.length === 0) return;

    const pulseWave = 0.5 + 0.5 * Math.sin(gameState.frameCount * 0.18);
    const isAiming = Boolean(gameState.isDragging && !gameState.isGameOver && gameState.selectedJelly);

    const renderMeta = {
        now: Date.now(),
        outlineColor: ACTIVE_THEME.outline || '#000000',
        unmergedAlpha: (ACTIVE_THEME.unmergedTextAlpha !== undefined) ? ACTIVE_THEME.unmergedTextAlpha : 0.56,
        isAiming,
        selectedMatchValue: isAiming ? gameState.selectedJelly.jellyValue : null,
        resonanceAlpha: (0.35 + pulseWave * 0.50).toFixed(3),
        resonanceLineWidth: 8.5 + pulseWave * 2.5
    };

    // 1パス目：通常レイヤー（下段フィールド内 ＋ 上段待機中ゼリー）を描画し、ホップ中を後回しへ退避
    hoppingCompositesBuffer.length = 0;
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (!comp || comp.label !== 'jelly_composite') continue;

        if (comp.isBarHopping) {
            hoppingCompositesBuffer.push(comp);
            continue;
        }
        drawSingleSoftBody(ctx, comp, gameState, renderMeta);
    }

    // 2パス目：2.5D上段飛び越えホップ飛行中のゼリーを最前面レイヤーとして描画
    for (let i = 0; i < hoppingCompositesBuffer.length; i++) {
        drawSingleSoftBody(ctx, hoppingCompositesBuffer[i], gameState, renderMeta);
    }
    hoppingCompositesBuffer.length = 0;
}

// ==========================================
// サブ関数 4：順方向ダイレクトエイム矢印（中心起点白丸＆太矢印）・ホップ予測ドット・オフセットガイド
// ==========================================
function drawAimAndHopGuide(ctx, gameState) {
    if (!gameState || !gameState.isDragging || gameState.isGameOver) return;

    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;

    let originX = gameState.dragStartX;
    let originY = gameState.dragStartY;
    let selectedHalfH = 22;

    if (gameState.selectedJelly) {
        const sel = gameState.selectedJelly;
        selectedHalfH = sel.isFloating
            ? (sel.capsuleHalfHeight || Math.min(sel.targetRadius || 21.5, FLOAT_BAR.CHANNEL_HALF_HEIGHT || 22))
            : (sel.targetRadius || 21.5);

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
    const hopTriggerDy = (FLOAT_BAR.HOP_TRIGGER_DY !== undefined) ? FLOAT_BAR.HOP_TRIGGER_DY : -16;
    const isHopAim = Boolean(gameState.isHopAim || (dist >= cancelRadius && dy < hopTriggerDy));

    ctx.save();

    if (dist >= cancelRadius) {
        // (A) 上段飛び越えホップモード時：シンプルな放物線予測ドット（6〜7点）＆着地リング
        if (isHopAim && Array.isArray(gameState.hopPreviewPoints) && gameState.hopPreviewPoints.length > 0) {
            const previewPts = gameState.hopPreviewPoints;
            const ptCount = previewPts.length;
            for (let k = 0; k < ptCount; k++) {
                const pt = previewPts[k];
                const t = (k + 1) / ptCount;
                const dotRadius = Math.max(2.2, 4.4 - t * 1.6);
                const dotAlpha = Math.max(0.28, 0.90 - t * 0.45);

                ctx.beginPath();
                ctx.arc(pt.x, pt.y, dotRadius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(34, 211, 238, ${dotAlpha.toFixed(3)})`;
                ctx.fill();
            }

            const lastPt = previewPts[ptCount - 1];
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

        // (C) 本家準拠：中心起点白丸 ＋ 太い順方向実線矢印（ホップ時はシアン、通常時は白）
        const arrowColor = isHopAim ? '#22d3ee' : '#ffffff';
        const endX = originX + dx;
        const endY = originY + dy;
        const angle = Math.atan2(dy, dx);
        const headLen = 19;

        // 中心起点リング（本家実機画像の起点白丸表現）
        ctx.beginPath();
        ctx.arc(originX, originY, 9.5, 0, Math.PI * 2);
        ctx.strokeStyle = arrowColor;
        ctx.lineWidth = 3;
        ctx.stroke();

        // 矢印の軸（太めの実線）
        ctx.beginPath();
        ctx.moveTo(originX + Math.cos(angle) * 8, originY + Math.sin(angle) * 8);
        ctx.lineTo(endX - Math.cos(angle) * (headLen * 0.55), endY - Math.sin(angle) * (headLen * 0.55));
        ctx.strokeStyle = arrowColor;
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.stroke();

        // 矢印の先端（クッキリした三角ヘッド）
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(
            endX - headLen * Math.cos(angle - Math.PI / 6),
            endY - headLen * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
            endX - headLen * Math.cos(angle + Math.PI / 6),
            endY - headLen * Math.sin(angle + Math.PI / 6)
        );
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
// サブ関数 5：バンパー押し込み時の警告オーバーレイ
// ==========================================
function drawWarningOverlay(ctx, gameState, bumperState) {
    if (!bumperState || !gameState) return;
    if ((bumperState.leftPressed || bumperState.rightPressed) && !gameState.isGameOver) {
        const alpha = Math.abs(Math.sin(gameState.frameCount * 0.1)) * 0.15;
        ctx.fillStyle = `rgba(255, 71, 87, ${alpha})`;
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }
}

/**
 * 毎フレーム呼ばれるメインの描画処理
 * @param {CanvasRenderingContext2D} ctx - 描画先のCanvasコンテキスト
 * @param {Object} world - Matter.jsの物理世界
 * @param {Object} gameState - 現在のゲーム状態
 * @param {Object} bumperState - バンパーの状態と実体 (leftBumper, rightBumper, leftPressed, rightPressed, leftPushRatio, rightPushRatio)
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

    // 3. ソフトボディ本体（通常レイヤー ＋ ホップ最前面レイヤー）
    drawSoftBodies(ctx, composites, gameState);

    // 4. 順方向ダイレクトエイム矢印・ホップ予測ドット・オフセットガイド
    drawAimAndHopGuide(ctx, gameState);

    // 5. 警告エフェクト
    drawWarningOverlay(ctx, gameState, bumperState);

    ctx.restore();
}