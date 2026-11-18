/**
 * render.js
 * @version v2.0 (Bugfix Step 6)
 * @changes
 *   - 極端な変形時のヒゲ状描画崩れを防ぐため、外縁法線が重心から見て内向き反転した場合は外向き放射状方向へフォールバックする処理を追加
 *   - physics.js のバンパー押し込み構造に連動し、壁の内側領域でクリップして半円バンパーが壁の奥へ沈み込む描画へ最適化
 *   - ドラッグ前から上部フロートバーと待機ゼリーが操作可能であることを直感的に伝える控えめなレール表現と微細な待機枠を追加
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスに ?v=2 を付与
 * 
 * ソフトボディのパーティクル群を滑らかなスライムとして描画するレンダリングモジュール
 * 
 * 外殻パーティクルの「外縁（外側のフチ）」をベジェ曲線で結ぶことで、
 * 隙間なく密着して流動的に変形する本家sobosuba風のスライムを表現します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, JELLY_CONFIG, EFFECTS, CONTAINER, PHYSICS, FLOAT_BAR } from '/sobosuba/constants.js?v=2';

/**
 * 毎フレーム呼ばれるメインの描画処理
 * @param {CanvasRenderingContext2D} ctx - 描画先のCanvasコンテキスト
 * @param {Object} world - Matter.jsの物理世界
 * @param {Object} gameState - 現在のゲーム状態
 * @param {Object} bumperState - バンパーの状態と実体 (leftBumper, rightBumper, leftPressed, rightPressed)
 */
export function renderGame(ctx, world, gameState, bumperState) {
    // 1. 背景のクリア（漆黒のプレイフィールド）
    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // 2. 容器の底面45度角カット＆外枠の描画
    const cut = CONTAINER.CORNER_CUT_SIZE;
    ctx.fillStyle = '#262626';

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
    ctx.strokeStyle = '#3a3a3a';
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

    // 4. ソフトボディ（スライム）の外縁密着描画
    const composites = Matter.Composite.allComposites(world);
    const durationMs = EFFECTS.MERGE_EXPAND_FRAMES * (1000 / 60);

    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp.label !== 'jelly_composite') continue;

        let core = comp.core || null;
        let particles = comp.particles || null;

        if (!core || !particles) {
            particles = [];
            for (let j = 0; j < comp.bodies.length; j++) {
                const b = comp.bodies[j];
                if (b.label === 'jelly_core') core = b;
                else if (b.label === 'jelly_particle') particles.push(b);
            }
        }

        if (!core || particles.length < 3) continue;

        const config = JELLY_CONFIG[core.jellyValue] || JELLY_CONFIG[8192];
        const n = particles.length;
        const pRadius = comp.particleRadius || (config.radius * 0.25);

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
                const fallbackAngle = (j / n) * Math.PI * 2;
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
        if (core.createdAt) {
            const elapsedMs = Date.now() - core.createdAt;
            if (elapsedMs < durationMs) {
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

        // --- Blob（スライム）外縁形状の描画 ---
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

        // 選択中のバー上ゼリーは白い太枠でハイライト、非選択のバー上待機ゼリーには微細な待機枠を描画
        if (isSelected) {
            ctx.lineWidth = 8;
            ctx.strokeStyle = '#ffffff';
            ctx.lineJoin = 'round';
            ctx.stroke();
        } else if (comp.isFloating) {
            ctx.lineWidth = 5;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.lineJoin = 'round';
            ctx.stroke();
        }

        ctx.fillStyle = config.color;
        ctx.fill();

        // 非選択時は本家準拠のハッキリとした黒い境界線を描画
        if (!isSelected) {
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = '#000000';
            ctx.stroke();
        }

        ctx.restore();

        // --- 数字の描画（傾き追従＆角張りデジタル風フォント） ---
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(core.angle);
        ctx.scale(scale, scale);

        ctx.fillStyle = config.text;
        ctx.font = `900 ${Math.max(14, config.radius * 0.6)}px "Courier New", Courier, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(core.jellyValue, 0, 0);
        ctx.restore();
    }

    // 5. 順方向ダイレクトエイム矢印（指を動かした方向へ伸びる白い実線矢印）の描画
    // ※スイカゲームの縦点線ガイドラインは完全廃止
    if (gameState.isDragging && !gameState.isGameOver) {
        let originX = gameState.dragStartX;
        let originY = gameState.dragStartY;

        if (gameState.selectedJelly && gameState.selectedJelly.core) {
            originX = gameState.selectedJelly.core.position.x;
            originY = gameState.selectedJelly.core.position.y;
        }

        const dx = gameState.dragVectorX;
        const dy = gameState.dragVectorY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 18;

        // キャンセル判定エリアを示す半透明のグレー円
        ctx.save();
        ctx.beginPath();
        ctx.arc(originX, originY, cancelRadius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(200, 200, 200, 0.35)';
        ctx.fill();

        // キャンセル半径を超えて引っ張っている場合のみ、順方向の白い実線矢印を描画
        if (dist >= cancelRadius) {
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
        }
        ctx.restore();
    }

    // 6. 警告エフェクト（片方または両方のバンパーが押し込まれている時に画面を赤く明滅）
    if ((bumperState.leftPressed || bumperState.rightPressed) && !gameState.isGameOver) {
        const alpha = Math.abs(Math.sin(gameState.frameCount * 0.1)) * 0.15;
        ctx.fillStyle = `rgba(255, 71, 87, ${alpha})`;
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }
}