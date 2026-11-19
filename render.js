/**
 * render.js
 * @version v3.0 (Overhaul Step 8)
 * @changes
 *   - 「黒枠 stroke() → ネオン塗り fill()」の描画順逆転により、小さいゼリーが黒く塗り潰される描画バグを構造的に完全解消
 *   - 本家準拠の hasMerged フラグに応じて、未合体Soboを「細字・薄色」、合体済みSoboを「太字・濃色」で描き分ける仕様を実装
 *   - 中心コア廃止に伴い、中空ビーズリングの重心（centroid）および循環平均回転角（avgAngle）による数字追従と、合体直後の微細なフラッシュ演出（mergeFlashUntil）を追加
 *   - Retina（DPR）高精細Canvas解像度へ自動対応するスケーリング変換と、「そっと落とし／中心戻しキャンセル」を判別できる視覚ガイドを実装
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスを /sobosuba/constants.js?v=3 へ統一
 * 
 * ソフトボディの中空ビーズリングを滑らかなスライムとして描画するレンダリングモジュール
 * 
 * 外殻パーティクルの「外縁（外側のフチ）」をベジェ曲線で結ぶことで、
 * 隙間なく密着して流動的に変形する本家sobosuba風のスライムを表現します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, ACTIVE_THEME, JELLY_CONFIG, EFFECTS, CONTAINER, PHYSICS, FLOAT_BAR } from '/sobosuba/constants.js?v=3';

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

    // 3. 上部左右の半円（かまぼこ型）バンパーの描画（壁の奥へ沈み込むクリップ連動）
    const drawHalfCircleBumper = (bumper, isPressed, isLeft) => {
        if (!bumper) return;

        const bw = bumper.bounds.max.x - bumper.bounds.min.x;
        const bh = bumper.bounds.max.y - bumper.bounds.min.y;
        const cy = (bumper.bounds.min.y + bumper.bounds.max.y) / 2;
        const radiusY = bh / 2;
        const radiusX = bw;

        ctx.save();
        // 容器の内側領域でクリップし、壁側へ押し込まれた部分が壁の奥へ自然に沈み込むようにする
        ctx.beginPath();
        ctx.rect(2, 0, GAME_WIDTH - 4, GAME_HEIGHT);
        ctx.clip();

        ctx.fillStyle = isPressed ? '#ff1e46' : '#4a4e57';
        ctx.strokeStyle = isPressed ? '#ff6b81' : '#6c727f';
        ctx.lineWidth = 2;
        ctx.shadowColor = isPressed ? '#ff1e46' : 'transparent';
        ctx.shadowBlur = isPressed ? 16 : 0;

        ctx.beginPath();
        if (isLeft) {
            // 左壁から内側（右）へ膨らむ半円（押し込み時は baseX < 0 となり壁奥へ沈み込む）
            const baseX = bumper.bounds.min.x;
            ctx.ellipse(baseX, cy, radiusX, radiusY, 0, -Math.PI / 2, Math.PI / 2, false);
        } else {
            // 右壁から内側（左）へ膨らむ半円（押し込み時は baseX > GAME_WIDTH となり壁奥へ沈み込む）
            const baseX = bumper.bounds.max.x;
            ctx.ellipse(baseX, cy, radiusX, radiusY, 0, Math.PI / 2, (Math.PI * 3) / 2, false);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    };

    drawHalfCircleBumper(bumperState.leftBumper, bumperState.leftPressed, true);
    drawHalfCircleBumper(bumperState.rightBumper, bumperState.rightPressed, false);

    // 4. ソフトボディ（中空ビーズリングスライム）の外縁密着描画
    const composites = Matter.Composite.allComposites(world);
    const durationMs = EFFECTS.MERGE_EXPAND_FRAMES * (1000 / 60);
    const now = Date.now();
    const outlineColor = ACTIVE_THEME.outline || '#000000';
    const unmergedAlpha = (ACTIVE_THEME.unmergedTextAlpha !== undefined) ? ACTIVE_THEME.unmergedTextAlpha : 0.45;

    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp.label !== 'jelly_composite') continue;

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
        const beadRatio = PHYSICS.BEAD_RADIUS_RATIO || 0.22;
        const pRadius = comp.particleRadius || (config.radius * beadRatio);

        // 重心の算出（数字の描画基準・膨張アニメーションの中心・外向き法線検証用）
        let cx = 0;
        let cy = 0;
        for (let j = 0; j < n; j++) {
            cx += particles[j].position.x;
            cy += particles[j].position.y;
        }
        cx /= n;
        cy /= n;

        // 各パーティクルの「外側のフチ（外縁）」座標を算出（内向き反転時は放射状フォールバック）
        const outerPoints = new Array(n);
        for (let j = 0; j < n; j++) {
            const pPrev = particles[(j - 1 + n) % n].position;
            const pCurr = particles[j].position;
            const pNext = particles[(j + 1) % n].position;

            // 重心からの外向き放射状ベクトルを算出
            const dx = pCurr.x - cx;
            const dy = pCurr.y - cy;
            const dLen = Math.sqrt(dx * dx + dy * dy);
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

            outerPoints[j] = {
                x: pCurr.x + nx * pRadius,
                y: pCurr.y + ny * pRadius
            };
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

        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);

        // --- Blob（スライム）外縁形状パスの構築 ---
        ctx.beginPath();
        let xc = (outerPoints[0].x + outerPoints[n - 1].x) / 2;
        let yc = (outerPoints[0].y + outerPoints[n - 1].y) / 2;
        ctx.moveTo(xc, yc);

        for (let j = 0; j < n; j++) {
            const nextPt = outerPoints[(j + 1) % n];
            xc = (outerPoints[j].x + nextPt.x) / 2;
            yc = (outerPoints[j].y + nextPt.y) / 2;
            ctx.quadraticCurveTo(outerPoints[j].x, outerPoints[j].y, xc, yc);
        }
        ctx.closePath();

        // 【黒潰れ完全防止】先に枠線（stroke）を描画し、後からネオン色（fill）で塗り潰す
        // これにより線の内側半分がネオン色で覆われ、どれだけ細く変形しても黒線が中身を飲み込まない
        ctx.lineJoin = 'round';
        if (isSelected) {
            // 選択中のバー上Sobo：外側にクッキリした白い太枠
            ctx.lineWidth = 8;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
        } else if (comp.isFloating) {
            // 非選択のバー上待機Sobo：控えめな待機枠 ＋ 黒境界線
            ctx.lineWidth = 7;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
            ctx.stroke();

            ctx.lineWidth = 4;
            ctx.strokeStyle = outlineColor;
            ctx.stroke();
        } else {
            // フィールド内Sobo：本家準拠のハッキリした黒境界線（fill前に描画して外側2.5pxのみ残す）
            ctx.lineWidth = 5;
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

        // --- 数字の描画（中空リングの循環平均回転角追従 ＆ 未合体/合体済みの細字・太字描き分け） ---
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(comp.avgAngle || 0);
        ctx.scale(scale, scale);

        const valueText = String(jellyValue);
        const digitScale = valueText.length >= 5 ? 0.62 : (valueText.length >= 4 ? 0.72 : (valueText.length >= 3 ? 0.85 : 1.0));
        const fontSize = Math.max(12, config.radius * 0.6 * digitScale);
        const isMerged = Boolean(comp.hasMerged);

        // 本家完全準拠：未合体は細字・薄色（スコア未加算）、合体済みは太字・濃色（スコア加算済み）
        ctx.fillStyle = config.text || ACTIVE_THEME.text || '#000000';
        ctx.globalAlpha = isMerged ? 1.0 : unmergedAlpha;
        ctx.font = `${isMerged ? '900' : '400'} ${fontSize}px "Courier New", Courier, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(valueText, 0, 0);
        ctx.restore();
    }

    // 5. 順方向ダイレクトエイム矢印 ＆ 「そっと落とし／中心戻しキャンセル」視覚ガイドの描画
    // ※スイカゲームの縦点線ガイドラインは完全廃止
    if (gameState.isDragging && !gameState.isGameOver) {
        let originX = gameState.dragStartX;
        let originY = gameState.dragStartY;

        if (gameState.selectedJelly) {
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
        const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 18;
        const hasDraggedOut = Boolean(gameState.hasDraggedOut);

        ctx.save();

        if (dist >= cancelRadius) {
            // ドラッグ発射モード：中心のキャンセルエリア円 ＋ 順方向の白い実線矢印
            ctx.beginPath();
            ctx.arc(originX, originY, cancelRadius, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(200, 200, 200, 0.30)';
            ctx.fill();

            const endX = originX + dx;
            const endY = originY + dy;
            const angle = Math.atan2(dy, dx);
            const headLen = 18;

            // 矢印の軸（白い実線）
            ctx.beginPath();
            ctx.moveTo(originX, originY);
            ctx.lineTo(endX - Math.cos(angle) * (headLen * 0.6), endY - Math.sin(angle) * (headLen * 0.6));
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 5;
            ctx.lineCap = 'round';
            ctx.stroke();

            // 矢印の先端（白い三角ヘッド）
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
            ctx.fillStyle = '#ffffff';
            ctx.fill();
        } else if (hasDraggedOut) {
            // 一度外へ伸ばしてから中心へ戻した状態：発射キャンセル視覚ガイド
            ctx.beginPath();
            ctx.arc(originX, originY, cancelRadius, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(180, 180, 180, 0.45)';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
            ctx.stroke();

            // キャンセルを示す控えめな「×」アイコン
            const crossR = 6;
            ctx.beginPath();
            ctx.moveTo(originX - crossR, originY - crossR);
            ctx.lineTo(originX + crossR, originY + crossR);
            ctx.moveTo(originX + crossR, originY - crossR);
            ctx.lineTo(originX - crossR, originY + crossR);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            ctx.stroke();
        } else {
            // タップしてまだ外へドラッグしていない状態：そのまま離すと「そっと落とし」視覚ガイド
            ctx.beginPath();
            ctx.arc(originX, originY, cancelRadius * 0.85, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 2;
            ctx.stroke();

            // 真下へのそっと落としを示唆する小さな下向きシェブロン
            const dropY = originY + (gameState.selectedJelly ? (gameState.selectedJelly.targetRadius || 18) : 18) + 8;
            ctx.beginPath();
            ctx.moveTo(originX - 6, dropY - 4);
            ctx.lineTo(originX, dropY + 3);
            ctx.lineTo(originX + 6, dropY - 4);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
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