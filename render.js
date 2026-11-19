/**
 * render.js
 * @version v4.0 (Final Overhaul Step 8)
 * @changes
 *   - 上段飛び越えホップモード時に矢印を明るいシアンへ切り替え、着地先がわかるシンプルな放物線予測ドット（gameState.hopPreviewPoints）を描画する機能を追加
 *   - 上段ゼリーを掴んでドラッグしている間、盤面および上段にある同じ数字のゼリー外枠が控えめに白く脈動する「共鳴ハイライト」を実装
 *   - スマホ実機で自分の指に隠れないよう、キャンセル（×バッジ）およびそっと落とし（下向き二重シェブロン）の視覚ガイドをゼリー上下のオフセット位置へ再配置
 *   - 極端な変形（くの字・細長い帯状）時でも数字が輪郭外へはみ出さないよう、ポリゴン内安全位置補正と実効厚み連動のフォントサイズ制限を追加
 *   - 外縁座標バッファの事前確保および world.composites 直接走査・軽量バンパー発光描画により、毎フレームのGC負荷とiOS WebView描画負荷を削減
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスを /sobosuba/constants.js?v=4 へ統一
 * 
 * ソフトボディの中空ビーズリングを滑らかなスライムとして描画するレンダリングモジュール
 * 
 * 外殻パーティクルの「外縁（外側のフチ）」をベジェ曲線で結ぶことで、
 * 隙間なく密着して流動的に変形する本家sobosuba風のスライムを表現します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, ACTIVE_THEME, JELLY_CONFIG, EFFECTS, CONTAINER, PHYSICS, FLOAT_BAR } from '/sobosuba/constants.js?v=4';

// ==========================================
// ゼロアロケーション（毎フレームGC負荷削減）用事前確保バッファ
// ==========================================
const INITIAL_OUTER_POINTS_CAPACITY = 48;
const outerPointsBuffer = Array.from({ length: INITIAL_OUTER_POINTS_CAPACITY }, () => ({ x: 0, y: 0 }));

/**
 * 事前確保した外縁座標バッファの容量が不足する場合のみ拡張する
 * @param {number} requiredCount
 */
function ensureOuterPointsCapacity(requiredCount) {
    while (outerPointsBuffer.length < requiredCount) {
        outerPointsBuffer.push({ x: 0, y: 0 });
    }
}

/**
 * 点 (px, py) が外縁ポリゴン内部にあるか Ray-Casting で判定する
 * （極端なくの字変形時に数字が輪郭の外へ浮遊するのを防ぐために使用）
 * @param {number} px
 * @param {number} py
 * @param {Array<{x: number, y: number}>} pts
 * @param {number} count
 * @returns {boolean}
 */
function isPointInsideOuterPoly(px, py, pts, count) {
    let inside = false;
    for (let i = 0, j = count - 1; i < count; j = i++) {
        const xi = pts[i].x;
        const yi = pts[i].y;
        const xj = pts[j].x;
        const yj = pts[j].y;

        if (((yi > py) !== (yj > py)) &&
            (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * 毎フレーム呼ばれるメインの描画処理
 * @param {CanvasRenderingContext2D} ctx - 描画先のCanvasコンテキスト
 * @param {Object} world - Matter.jsの物理世界
 * @param {Object} gameState - 現在のゲーム状態
 * @param {Object} bumperState - バンパーの状態と実体 (leftBumper, rightBumper, leftPressed, rightPressed)
 */
export function renderGame(ctx, world, gameState, bumperState) {
    // 0. Retina（DPR）高精細解像度対応：実Canvas解像度と論理サイズ（GAME_WIDTH x GAME_HEIGHT）を自動同期
    const canvas = ctx.canvas;
    const dprScaleX = (canvas && canvas.width > 0) ? (canvas.width / GAME_WIDTH) : 1;
    const dprScaleY = (canvas && canvas.height > 0) ? (canvas.height / GAME_HEIGHT) : 1;

    ctx.save();
    ctx.setTransform(dprScaleX, 0, 0, dprScaleY, 0, 0);

    // 1. 背景のクリア（漆黒のプレイフィールド）
    ctx.fillStyle = ACTIVE_THEME.containerBg || '#080808';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // 2. 容器の底面45度角カット＆外枠の描画
    const cut = CONTAINER.CORNER_CUT_SIZE;
    ctx.fillStyle = ACTIVE_THEME.cornerFill || '#262626';

    // 左下の角カット三角形
    ctx.beginPath();
    ctx.moveTo(0, GAME_HEIGHT - cut);
    ctx.lineTo(cut, GAME_HEIGHT);
    ctx.lineTo(0, GAME_HEIGHT);
    ctx.closePath();
    ctx.fill();

    // 右下の角カット三角形
    ctx.beginPath();
    ctx.moveTo(GAME_WIDTH, GAME_HEIGHT - cut);
    ctx.lineTo(GAME_WIDTH - cut, GAME_HEIGHT);
    ctx.lineTo(GAME_WIDTH, GAME_HEIGHT);
    ctx.closePath();
    ctx.fill();

    // 容器の外枠ライン（左右壁・斜めスロープ・底面）
    ctx.strokeStyle = ACTIVE_THEME.wallStroke || '#3a3a3a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(2, 0);
    ctx.lineTo(2, GAME_HEIGHT - cut);
    ctx.lineTo(cut, GAME_HEIGHT - 2);
    ctx.lineTo(GAME_WIDTH - cut, GAME_HEIGHT - 2);
    ctx.lineTo(GAME_WIDTH - 2, GAME_HEIGHT - cut);
    ctx.lineTo(GAME_WIDTH - 2, 0);
    ctx.stroke();

    // 2.5 上部フロートバー領域の控えめなレール表現（待機中の操作視認性向上）
    const barLeft = FLOAT_BAR.PADDING_X * 0.6;
    const barRight = GAME_WIDTH - FLOAT_BAR.PADDING_X * 0.6;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(barLeft, FLOAT_BAR.Y);
    ctx.lineTo(barRight, FLOAT_BAR.Y);
    ctx.stroke();
    ctx.restore();

    // 3. 上部左右の半円（かまぼこ型）バンパーの描画（壁の奥へ沈み込むクリップ連動 ＆ shadowBlur廃止による軽量化）
    const drawHalfCircleBumper = (bumper, isPressed, isLeft) => {
        if (!bumper) return;

        const bw = bumper.bounds.max.x - bumper.bounds.min.x;
        const bh = bumper.bounds.max.y - bumper.bounds.min.y;
        const cy = (bumper.bounds.min.y + bumper.bounds.max.y) / 2;
        const radiusY = bh / 2;
        const radiusX = bw;
        const baseX = isLeft ? bumper.bounds.min.x : bumper.bounds.max.x;
        const startAngle = isLeft ? (-Math.PI / 2) : (Math.PI / 2);
        const endAngle = isLeft ? (Math.PI / 2) : ((Math.PI * 3) / 2);

        ctx.save();
        // 容器の内側領域でクリップし、壁側へ押し込まれた部分が壁の奥へ自然に沈み込むようにする
        ctx.beginPath();
        ctx.rect(2, 0, GAME_WIDTH - 4, GAME_HEIGHT);
        ctx.clip();

        // 押し込み時の軽量グロウ演出（高負荷な shadowBlur を使わず半透明外側ストロークで表現）
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
    };

    drawHalfCircleBumper(bumperState.leftBumper, bumperState.leftPressed, true);
    drawHalfCircleBumper(bumperState.rightBumper, bumperState.rightPressed, false);

    // 4. ソフトボディ（中空ビーズリングスライム）の外縁密着描画
    // 毎フレームの配列新規生成を避けるため world.composites を直接走査
    const composites = (world && world.composites) ? world.composites : Matter.Composite.allComposites(world);
    const durationMs = EFFECTS.MERGE_EXPAND_FRAMES * (1000 / 60);
    const now = Date.now();
    const outlineColor = ACTIVE_THEME.outline || '#000000';
    const unmergedAlpha = (ACTIVE_THEME.unmergedTextAlpha !== undefined) ? ACTIVE_THEME.unmergedTextAlpha : 0.56;

    // ドラッグ中の「同数字 共鳴ハイライト」判定用パラメータ
    const isAiming = Boolean(gameState.isDragging && !gameState.isGameOver && gameState.selectedJelly);
    const selectedMatchValue = isAiming ? gameState.selectedJelly.jellyValue : null;
    const pulseWave = 0.5 + 0.5 * Math.sin(gameState.frameCount * 0.18);
    const resonanceAlpha = (0.35 + pulseWave * 0.50).toFixed(3);
    const resonanceLineWidth = 8.5 + pulseWave * 2.5;

    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (!comp || comp.label !== 'jelly_composite') continue;

        let particles = comp.particles || null;
        if (!particles) {
            particles = [];
            for (let j = 0; j < comp.bodies.length; j++) {
                const b = comp.bodies[j];
                if (b.label === 'jelly_particle') particles.push(b);
            }
        }

        if (particles.length < 3) continue;

        const jellyValue = comp.jellyValue || particles[0].jellyValue || 1;
        const config = JELLY_CONFIG[jellyValue] || JELLY_CONFIG[16384] || JELLY_CONFIG[8192];
        const n = particles.length;
        const beadRatio = PHYSICS.BEAD_RADIUS_RATIO || 0.26;
        const pRadius = comp.particleRadius || (config.radius * beadRatio);

        ensureOuterPointsCapacity(n);

        // 重心の算出（数字の描画基準・膨張アニメーションの中心・外向き法線検証用）
        let cx = 0;
        let cy = 0;
        for (let j = 0; j < n; j++) {
            cx += particles[j].position.x;
            cy += particles[j].position.y;
        }
        cx /= n;
        cy /= n;

        // 各パーティクルの「外側のフチ（外縁）」座標を事前確保バッファへ算出 ＆ 最小半径の計測
        let minRadialDist = Infinity;
        for (let j = 0; j < n; j++) {
            const pPrev = particles[(j - 1 + n) % n].position;
            const pCurr = particles[j].position;
            const pNext = particles[(j + 1) % n].position;

            // 重心からの外向き放射状ベクトルを算出
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

            const tx = pNext.x - pPrev.x;
            const ty = pNext.y - pPrev.y;
            const tLen = Math.sqrt(tx * tx + ty * ty);

            let nx = radialX;
            let ny = radialY;
            if (tLen > 0.0001) {
                // 時計回り（Canvas座標系）の外向き法線候補
                const candNx = ty / tLen;
                const candNy = -tx / tLen;
                // 重心から見て外向き（内積が正）の場合のみ採用し、ヒゲ状の描画崩れを防止
                if ((candNx * radialX + candNy * radialY) > 0) {
                    nx = candNx;
                    ny = candNy;
                }
            }

            const outPt = outerPointsBuffer[j];
            outPt.x = pCurr.x + nx * pRadius;
            outPt.y = pCurr.y + ny * pRadius;
        }

        // 膨張アニメーションスケールの計算
        let scale = 1.0;
        if (comp.createdAt) {
            const elapsedMs = now - comp.createdAt;
            if (elapsedMs >= 0 && elapsedMs < durationMs) {
                const progress = elapsedMs / durationMs;
                scale = 1.0 + Math.sin(progress * Math.PI) * (EFFECTS.MERGE_EXPAND_SCALE - 1.0);
            }
        }

        // 上部フロートバー上で現在選択されているゼリーかどうか判定
        const isSelected = Boolean(
            comp.isFloating &&
            (
                (gameState.selectedJelly && gameState.selectedJelly === comp) ||
                (gameState.selectedJellyId && comp.jellyId === gameState.selectedJellyId)
            )
        );

        // ドラッグ中の同数字「共鳴ハイライト」対象かどうか判定（選択中ゼリー自身を除く）
        const isResonanceMatch = Boolean(
            isAiming &&
            !isSelected &&
            !comp.isMerging &&
            selectedMatchValue !== null &&
            jellyValue === selectedMatchValue
        );

        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);

        // --- Blob（スライム）外縁形状パスの構築 ---
        ctx.beginPath();
        let xc = (outerPointsBuffer[0].x + outerPointsBuffer[n - 1].x) / 2;
        let yc = (outerPointsBuffer[0].y + outerPointsBuffer[n - 1].y) / 2;
        ctx.moveTo(xc, yc);

        for (let j = 0; j < n; j++) {
            const currPt = outerPointsBuffer[j];
            const nextPt = outerPointsBuffer[(j + 1) % n];
            xc = (currPt.x + nextPt.x) / 2;
            yc = (currPt.y + nextPt.y) / 2;
            ctx.quadraticCurveTo(currPt.x, currPt.y, xc, yc);
        }
        ctx.closePath();

        // 【黒潰れ完全防止】先に枠線（stroke）を描画し、後からネオン色（fill）で塗り潰す
        ctx.lineJoin = 'round';
        if (isSelected) {
            // 選択中のバー上Sobo：外側にクッキリした白い太枠
            ctx.lineWidth = 8;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
        } else {
            // ドラッグ中の同数字「共鳴ハイライト」：外枠が控えめに白く脈動して合体先を直感的に提示
            if (isResonanceMatch) {
                ctx.lineWidth = resonanceLineWidth;
                ctx.strokeStyle = `rgba(255, 255, 255, ${resonanceAlpha})`;
                ctx.stroke();
            } else if (comp.isFloating) {
                // 非選択のバー上待機Sobo：控えめな待機枠
                ctx.lineWidth = 7;
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
                ctx.stroke();
            }

            // 本家準拠のハッキリした黒境界線（fill前に描画して外側のみ残す）
            ctx.lineWidth = comp.isFloating ? 4 : 5;
            ctx.strokeStyle = outlineColor;
            ctx.stroke();
        }

        // 内側をフラットなビビッドカラーで塗り潰す
        ctx.fillStyle = config.color;
        ctx.fill();

        // 合体直後の微細なフラッシュ演出（保護時間・フラッシュ時間中のみふわっと白く光る）
        if (comp.mergeFlashUntil && now < comp.mergeFlashUntil) {
            const totalFlash = Math.max(120, comp.mergeFlashUntil - (comp.createdAt || (comp.mergeFlashUntil - 120)));
            const remain = comp.mergeFlashUntil - now;
            const flashRatio = Math.max(0, Math.min(1, remain / totalFlash));
            ctx.fillStyle = `rgba(255, 255, 255, ${(flashRatio * 0.45).toFixed(3)})`;
            ctx.fill();
        }

        ctx.restore();

        // --- 数字の描画（極端変形時のはみ出し・輪郭外浮遊防止 ＆ 未合体/合体済みの細字・太字描き分け） ---
        let textX = cx;
        let textY = cy;
        let effectiveThickness = minRadialDist + pRadius;

        // くの字等の極端な凹み変形で重心が輪郭の外へ出た場合、ポリゴン内部の安全な代表点へ補正
        if (!isPointInsideOuterPoly(textX, textY, outerPointsBuffer, n)) {
            let bestDistSq = Infinity;
            const halfN = Math.floor(n / 2);
            let foundInside = false;

            for (let j = 0; j < n; j++) {
                const pA = particles[j].position;
                const pB = particles[(j + halfN) % n].position;
                const mx = (pA.x + pB.x) * 0.5;
                const my = (pA.y + pB.y) * 0.5;
                if (isPointInsideOuterPoly(mx, my, outerPointsBuffer, n)) {
                    const ddx = mx - cx;
                    const ddy = my - cy;
                    const dSq = ddx * ddx + ddy * ddy;
                    if (dSq < bestDistSq) {
                        bestDistSq = dSq;
                        textX = mx;
                        textY = my;
                        foundInside = true;
                    }
                }
            }

            // それでも内点が見つからない極限変形時は重心に最も近いビーズ中心へ退避
            if (!foundInside) {
                let nearestSq = Infinity;
                for (let j = 0; j < n; j++) {
                    const p = particles[j].position;
                    const ddx = p.x - cx;
                    const ddy = p.y - cy;
                    const dSq = ddx * ddx + ddy * ddy;
                    if (dSq < nearestSq) {
                        nearestSq = dSq;
                        textX = p.x;
                        textY = p.y;
                    }
                }
                effectiveThickness = Math.min(effectiveThickness, pRadius * 1.4);
            } else {
                // 補正後の内点から最も近い外周点までの距離で実効厚みを再計算
                let correctedMin = Infinity;
                for (let j = 0; j < n; j++) {
                    const ox = outerPointsBuffer[j].x - textX;
                    const oy = outerPointsBuffer[j].y - textY;
                    const d = Math.sqrt(ox * ox + oy * oy);
                    if (d < correctedMin) correctedMin = d;
                }
                effectiveThickness = Math.min(effectiveThickness, correctedMin);
            }
        }

        ctx.save();
        ctx.translate(textX, textY);
        ctx.rotate(comp.avgAngle || 0);
        ctx.scale(scale, scale);

        const valueText = String(jellyValue);
        const digitScale = valueText.length >= 5 ? 0.62 : (valueText.length >= 4 ? 0.72 : (valueText.length >= 3 ? 0.85 : 1.0));
        const baseFontSize = Math.max(11, config.radius * 0.62 * digitScale);
        // 極端に細く潰れた際に文字が輪郭から突き出さないよう、実効厚みに応じて上限クランプ
        const safeWidthLimit = Math.max(8, effectiveThickness * 1.45 * digitScale);
        const fontSize = Math.min(baseFontSize, safeWidthLimit);
        const isMerged = Boolean(comp.hasMerged);

        // 本家完全準拠：未合体は細字・薄色（スコア未加算）、合体済みは太字・濃色（スコア加算済み）
        ctx.fillStyle = config.text || ACTIVE_THEME.text || '#000000';
        ctx.globalAlpha = isMerged ? 1.0 : unmergedAlpha;
        ctx.font = `${isMerged ? '900' : '400'} ${fontSize.toFixed(1)}px "Courier New", Courier, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(valueText, 0, 0);
        ctx.restore();
    }

    // 5. 順方向ダイレクトエイム矢印・上段ホップ予測ドット・指に隠れないオフセット型ガイドの描画
    // ※スイカゲームの縦点線ガイドラインは完全廃止
    if (gameState.isDragging && !gameState.isGameOver) {
        let originX = gameState.dragStartX;
        let originY = gameState.dragStartY;
        let selectedRadius = 16;

        if (gameState.selectedJelly) {
            selectedRadius = gameState.selectedJelly.targetRadius || 16;
            if (gameState.selectedJelly.centroid) {
                originX = gameState.selectedJelly.centroid.x;
                originY = gameState.selectedJelly.centroid.y;
            } else if (gameState.selectedJelly.particles && gameState.selectedJelly.particles.length > 0) {
                const pts = gameState.selectedJelly.particles;
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
        const hopTriggerDy = (FLOAT_BAR.HOP_TRIGGER_DY !== undefined) ? FLOAT_BAR.HOP_TRIGGER_DY : -12;
        const isHopAim = Boolean(gameState.isHopAim || (dist >= cancelRadius && dy < hopTriggerDy));

        ctx.save();

        if (dist >= cancelRadius) {
            // (A) 上段飛び越えホップモード時：シンプルな放物線予測ドット（6〜7点）を先に描画
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

                // 予測着地位置（末尾点）に控えめな再吸着リングを表示
                const lastPt = previewPts[ptCount - 1];
                ctx.beginPath();
                ctx.arc(lastPt.x, lastPt.y, 7.5, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(34, 211, 238, 0.70)';
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // (B) 中心のキャンセルエリア円
            ctx.beginPath();
            ctx.arc(originX, originY, cancelRadius, 0, Math.PI * 2);
            ctx.fillStyle = isHopAim ? 'rgba(34, 211, 238, 0.22)' : 'rgba(200, 200, 200, 0.26)';
            ctx.fill();

            // (C) 順方向の太い実線矢印（ホップ時は明るいシアン、通常ショット時は白）
            const arrowColor = isHopAim ? '#22d3ee' : '#ffffff';
            const endX = originX + dx;
            const endY = originY + dy;
            const angle = Math.atan2(dy, dx);
            const headLen = 18;

            // 矢印の軸
            ctx.beginPath();
            ctx.moveTo(originX, originY);
            ctx.lineTo(endX - Math.cos(angle) * (headLen * 0.6), endY - Math.sin(angle) * (headLen * 0.6));
            ctx.strokeStyle = arrowColor;
            ctx.lineWidth = 5;
            ctx.lineCap = 'round';
            ctx.stroke();

            // 矢印の先端（三角ヘッド）
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
            ctx.arc(originX, originY, Math.max(cancelRadius, selectedRadius + 6), 0, Math.PI * 2);
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
            ctx.stroke();
            ctx.setLineDash([]);

            // ゼリー上方の指に隠れない位置へキャンセル「×」バッジをオフセット表示
            const badgeX = Math.max(18, Math.min(GAME_WIDTH - 18, originX));
            const badgeY = Math.max(18, originY - selectedRadius - 22);

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
            ctx.arc(originX, originY, selectedRadius + 6, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 2;
            ctx.stroke();

            // 指先に隠れにくいゼリー下方オフセット位置へ下向き二重シェブロンを表示
            const dropBaseY = originY + selectedRadius + 16;
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

    // 6. 警告エフェクト（片方または両方のバンパーが押し込まれている時に画面を赤く明滅）
    if ((bumperState.leftPressed || bumperState.rightPressed) && !gameState.isGameOver) {
        const alpha = Math.abs(Math.sin(gameState.frameCount * 0.1)) * 0.15;
        ctx.fillStyle = `rgba(255, 71, 87, ${alpha})`;
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }

    ctx.restore();
}