/**
 * aim.js
 * @version v8.9 (Hop Preview Air-Damping Fix, Zero-Alloc Preview Pool & v8.6 Radius Fallback Sync - Phase 1)
 * @changes
 *   - updateHopPreviewPoints() の 1 サブステップあたりの空気抵抗減衰式を Matter.js v0.20 の timeScale 固定刻み積分と一致させ（1 - frictionAir * timeScale）、長距離ホップ時の水平予測着地ズレを解消
 *   - ホップ軌道プレビューのサンプリング点生成を事前確保 7 点プール（hopPreviewPointPool）へ置換し、ドラッグ中の毎フレーム一時オブジェクト生成（GC負荷）を削減
 *   - v8.6 サイズ拡大定数に合わせて基準半径フォールバック値を 24.0 → 25.5 へ同期
 * 
 * 上段フロートバーのゼリー選択、360度順方向ダイレクトエイム、
 * 天井非激突2.5D上段飛び越えホップ自動切替および放物線軌道プレビュー計算を担う操作モジュール
 */

import { GAME_WIDTH, CONTAINER, PHYSICS, FLOAT_BAR } from '/sobosuba/constants.js?v=7';
import {
    getSoftBodyCentroid,
    getSoftBodyHalfExtents,
    launchFloatingJelly,
    launchBarHop
} from '/sobosuba/softbody.js?v=7';
import { getSafeHopMaxUpSpeed } from '/sobosuba/bar_motion.js?v=7';
import { getFloatingJellies } from '/sobosuba/floatbar.js?v=7';
import { ensureAudioRunning, playSoundSelect, playSoundShoot, playSoundHop } from '/sobosuba/sound.js?v=7';

// ==========================================
// ホップ軌道プレビュー計算用の事前確保スクラッチバッファ＆点プール（GC負荷削減）
// ==========================================
const HOP_PREVIEW_DOT_COUNT = 7;
const hopTraceScratchX = [];
const hopTraceScratchY = [];
const hopPreviewPointPool = Array.from({ length: HOP_PREVIEW_DOT_COUNT }, () => ({ x: 0, y: 0 }));

/**
 * ドラッグベクトルが「2.5D上段飛び越えホップ」発動条件（キャンセル半径外 ＆ 上向き閾値 ＆ 角度勾配）を満たすか判定する
 * @param {number} vecX - X方向ドラッグ量
 * @param {number} vecY - Y方向ドラッグ量
 * @param {number} dist - ドラッグ距離
 * @returns {boolean} ホップ発動条件を満たす場合は true
 */
function isHopDirection(vecX, vecY, dist) {
    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 22;
    const hopTriggerDy = (FLOAT_BAR.HOP_TRIGGER_DY !== undefined) ? FLOAT_BAR.HOP_TRIGGER_DY : -16;
    const hopTriggerSlope = (FLOAT_BAR.HOP_TRIGGER_SLOPE !== undefined) ? FLOAT_BAR.HOP_TRIGGER_SLOPE : 0.42;
    return dist >= cancelRadius &&
        vecY < hopTriggerDy &&
        (-vecY) > Math.abs(vecX) * hopTriggerSlope;
}

/**
 * エイムおよびホップ予測に関連する gameState フィールドを安全に初期化する
 * @param {Object} gameState - ゲーム状態オブジェクト
 */
export function resetAimState(gameState) {
    if (!gameState) return;
    gameState.selectedJelly = null;
    gameState.selectedJellyId = null;
    gameState.isDragging = false;
    gameState.hasDraggedOut = false;
    gameState.isHopAim = false;
    if (Array.isArray(gameState.hopPreviewPoints)) {
        gameState.hopPreviewPoints.length = 0;
    } else {
        gameState.hopPreviewPoints = [];
    }
    gameState.dragPointerStartX = 0;
    gameState.dragPointerStartY = 0;
    gameState.dragOffsetX = 0;
    gameState.dragOffsetY = 0;
    gameState.dragStartX = 0;
    gameState.dragStartY = 0;
    gameState.dragCurrentX = 0;
    gameState.dragCurrentY = 0;
    gameState.dragVectorX = 0;
    gameState.dragVectorY = 0;
}

/**
 * ドラッグ方向に応じた最大ドラッグ距離を C1 連続で算出する
 * 上半円（dy <= 0）は半径 AIM_MAX_DRAG（120px）、下半楕円（dy > 0）は横 120px × 縦 AIM_MAX_DRAG_DOWN（170px）
 * @param {number} dx - X方向ドラッグ量
 * @param {number} dy - Y方向ドラッグ量
 * @returns {number} 方向別の最大ドラッグ距離（px）
 */
function getMaxDragForDirection(dx, dy) {
    const baseMaxDrag = PHYSICS.AIM_MAX_DRAG || 120;
    if (dy <= 0) {
        return baseMaxDrag;
    }
    const downMaxDrag = Math.max(baseMaxDrag, PHYSICS.AIM_MAX_DRAG_DOWN || 170);
    const rawDist = Math.sqrt(dx * dx + dy * dy);
    if (rawDist <= 1e-8) {
        return baseMaxDrag;
    }
    const cosT = dx / rawDist;
    const sinT = dy / rawDist;
    const invR = Math.sqrt(
        (cosT * cosT) / (baseMaxDrag * baseMaxDrag) +
        (sinT * sinT) / (downMaxDrag * downMaxDrag)
    );
    return invR > 1e-8 ? (1 / invR) : baseMaxDrag;
}

/**
 * ドラッグベクトルを方向別の最大ドラッグ距離（上半円 120px / 下半楕円 120x170px）で連続クランプする（360度解放）
 * @param {number} dx - X方向ドラッグ量
 * @param {number} dy - Y方向ドラッグ量
 * @returns {{ x: number, y: number }} クランプ済みベクトル
 */
export function clampAimVector(dx, dy) {
    let vecX = dx;
    let vecY = dy;
    const rawDist = Math.sqrt(vecX * vecX + vecY * vecY);
    const maxDrag = getMaxDragForDirection(vecX, vecY);

    if (rawDist > maxDrag) {
        const ratio = maxDrag / rawDist;
        vecX *= ratio;
        vecY *= ratio;
    }

    return { x: vecX, y: vecY };
}

/**
 * 上向きドラッグベクトルから「天井非激突 2.5D上段飛び越えホップ（Bar-Hop）」用の初速ベクトルを線形マッピングで算出する
 * @param {number} vecX - クランプ済みX方向ドラッグ量
 * @param {number} vecY - クランプ済みY方向ドラッグ量
 * @returns {{ x: number, y: number }} ホップ初速ベクトル（px/frame 単位）
 */
export function computeHopVelocity(vecX, vecY) {
    const xMult = (FLOAT_BAR.HOP_X_MULTIPLIER !== undefined) ? FLOAT_BAR.HOP_X_MULTIPLIER : 0.075;
    const minUpSpeed = (FLOAT_BAR.HOP_MIN_UP_SPEED !== undefined) ? FLOAT_BAR.HOP_MIN_UP_SPEED : 5.80;
    const maxUpSpeed = (FLOAT_BAR.HOP_MAX_UP_SPEED !== undefined) ? FLOAT_BAR.HOP_MAX_UP_SPEED : 6.55;
    const hopTriggerDy = (FLOAT_BAR.HOP_TRIGGER_DY !== undefined) ? FLOAT_BAR.HOP_TRIGGER_DY : -16;
    const maxDrag = Math.max(Math.abs(hopTriggerDy) + 1, PHYSICS.AIM_MAX_DRAG || 120);
    const maxHopSpeed = FLOAT_BAR.HOP_MAX_SPEED || 11.5;

    const vx = vecX * xMult;

    // 上向きドラッグ量 |vecY| を [|HOP_TRIGGER_DY|, AIM_MAX_DRAG] から [0, 1] へ線形マッピング
    const minDyAbs = Math.abs(hopTriggerDy);
    const upPull = Math.max(0, -vecY - minDyAbs);
    const t = Math.max(0, Math.min(1, upPull / (maxDrag - minDyAbs)));
    const upSpeed = minUpSpeed + t * (maxUpSpeed - minUpSpeed);
    const vy = -upSpeed;

    const speedSq = vx * vx + vy * vy;
    if (speedSq > maxHopSpeed * maxHopSpeed) {
        const scale = maxHopSpeed / Math.sqrt(speedSq);
        return {
            x: vx * scale,
            y: vy * scale
        };
    }

    return { x: vx, y: vy };
}

/**
 * 2.5D上段飛び越えホップ時の放物線予測ドット（一体外枠フレーム内壁・天井反射込み、着地先まで7点）を
 * bar_motion.js / softbody.js / physics.js の半カプセル実寸法・天井非激突初速制限・リキャッチ高度・
 * Matter.js 0.20 timeScale 固定刻み物理定数・X/Y独立速度クランプと 1px 精度で同期して算出する
 * @param {Matter.Engine|null} engine - Matter.js物理エンジン
 * @param {Object} gameState - ゲーム状態オブジェクト
 * @param {Matter.Composite} selected - 選択中のゼリーコンポジット
 * @param {{ x: number, y: number }} centroid - 選択ゼリーの現在重心
 * @param {{ x: number, y: number }} hopVel - 算出済みホップ初速ベクトル
 */
export function updateHopPreviewPoints(engine, gameState, selected, centroid, hopVel) {
    if (!gameState) return;
    if (!Array.isArray(gameState.hopPreviewPoints)) {
        gameState.hopPreviewPoints = [];
    }
    const out = gameState.hopPreviewPoints;
    out.length = 0;

    if (!selected || !centroid || !hopVel) return;

    // launchBarHop() と同様に現在のバー上横移動速度の HOP_INHERIT_VX（0.2）および値 64 以上の天井非激突上限を加味
    let avgVx = 0;
    const pts = selected.particles;
    if (pts && pts.length > 0) {
        for (let i = 0; i < pts.length; i++) {
            avgVx += pts[i].velocity.x;
        }
        avgVx /= pts.length;
    }

    const inheritVx = (FLOAT_BAR.HOP_INHERIT_VX !== undefined) ? FLOAT_BAR.HOP_INHERIT_VX : 0.2;
    const maxVx = PHYSICS.MAX_PARTICLE_VX || 10.5;
    const maxVy = PHYSICS.MAX_PARTICLE_VY || 12.0;
    const maxHopSpeed = FLOAT_BAR.HOP_MAX_SPEED || 11.5;
    const safeMaxUpSpeed = getSafeHopMaxUpSpeed(selected);
    const limitedHopY = (hopVel.y < -safeMaxUpSpeed) ? -safeMaxUpSpeed : hopVel.y;
    let vx = avgVx * inheritVx + hopVel.x;
    let vy = limitedHopY;
    const initSpeedSq = vx * vx + vy * vy;
    if (initSpeedSq > maxHopSpeed * maxHopSpeed) {
        const s = maxHopSpeed / Math.sqrt(initSpeedSq);
        vx *= s;
        vy *= s;
    }

    // ホップ飛行中は半カプセル（shapeBlend = 0.5）を維持するため、半カプセル実半幅・実半高と内壁座標で反射判定
    const r = selected.targetRadius || 25.5;
    const capW = selected.capsuleHalfWidth || r;
    const capH = selected.capsuleHalfHeight || r;
    const halfW = (r + capW) * 0.5;
    const halfH = (r + capH) * 0.5;

    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;
    const minX = frameW + halfW;
    const maxX = GAME_WIDTH - frameW - halfW;
    const minY = topBarH + halfH;

    const substeps = Math.max(1, PHYSICS.SUBSTEPS || 4);
    const baseDelta = 1000 / 60;
    const subDelta = baseDelta / substeps;
    const timeScale = subDelta / baseDelta;
    const gravityY = engine ? engine.gravity.y : PHYSICS.GRAVITY_Y;
    const gravityScale = engine ? engine.gravity.scale : 0.001;
    const hopGravScale = (FLOAT_BAR.HOP_GRAVITY_SCALE !== undefined) ? FLOAT_BAR.HOP_GRAVITY_SCALE : 1.92;
    const subAccY = gravityY * gravityScale * hopGravScale * subDelta * subDelta;
    const subAccVy = subAccY / timeScale;
    const airDamp = 1 - (PHYSICS.FRICTION_AIR || 0.0012) * timeScale;
    const wallRestitution = (PHYSICS.RESTITUTION !== undefined) ? PHYSICS.RESTITUTION : 0.12;
    const minAirSteps = Math.ceil((FLOAT_BAR.HOP_MIN_AIR_MS || 160) / subDelta);
    const targetBarY = FLOAT_BAR.Y;
    const recatchYMin = FLOAT_BAR.HOP_RECATCH_Y_MIN || 102;
    const recatchYMax = FLOAT_BAR.HOP_RECATCH_Y_MAX || 138;

    let px = centroid.x;
    let py = centroid.y;

    hopTraceScratchX.length = 0;
    hopTraceScratchY.length = 0;

    const maxSimSteps = 260;
    for (let step = 1; step <= maxSimSteps; step++) {
        // Matter.js 0.20 timeScale 固定刻み積分 ＆ softbody.js の clampParticleVelocities (X/Y独立クランプ) に完全同期
        vx = Math.max(-maxVx, Math.min(maxVx, vx * airDamp));
        vy = Math.max(-maxVy, Math.min(maxVy, vy * airDamp + subAccVy));
        px += vx * timeScale;
        py += vy * timeScale;

        // 一体外枠フレーム内壁基準の左右壁（PHYSICS.RESTITUTION）・天井クッション（0.45）反射シミュレーション
        if (px < minX) {
            px = minX;
            vx = Math.abs(vx) * wallRestitution;
        } else if (px > maxX) {
            px = maxX;
            vx = -Math.abs(vx) * wallRestitution;
        }
        if (py < minY) {
            py = minY;
            vy = Math.abs(vy) * 0.45;
        }

        hopTraceScratchX.push(px);
        hopTraceScratchY.push(py);

        // 下降フェーズで bar_motion.js のリキャッチ開始高度（HOP_RECATCH_Y_MIN）へ到達したら着地予定位置として終了
        if (step >= minAirSteps && ((vy >= 0 && py >= recatchYMin) || py > recatchYMax)) {
            hopTraceScratchY[hopTraceScratchY.length - 1] = targetBarY;
            break;
        }
    }

    const total = hopTraceScratchX.length;
    if (total === 0) return;

    // 放物線軌道から均等に7点（末尾は必ず予測着地位置）を事前確保プールでサンプリング
    const dotCount = Math.min(HOP_PREVIEW_DOT_COUNT, total);
    for (let k = 1; k <= dotCount; k++) {
        const idx = Math.min(total - 1, Math.max(0, Math.round((k / dotCount) * (total - 1))));
        const pt = hopPreviewPointPool[k - 1];
        pt.x = hopTraceScratchX[idx];
        pt.y = hopTraceScratchY[idx];
        out.push(pt);
    }
}

/**
 * 端狙い・斜め下ショット時に隣カプセル角の引っ掛かりを防ぐすり抜け保護（useBarGrace）を有効にすべきか判定する
 * （dy >= LAUNCH_GRACE_MIN_DY (-2) であり、かつ進行方向すぐ隣に同数字がいない場合のみ true）
 * @param {Matter.Composite} selected - 発射する選択ゼリー
 * @param {{ x: number, y: number }} safeAim - クランプ済みドラッグベクトル
 * @param {Matter.World|null} world - 物理世界（同数字隣接判定用）
 * @returns {boolean}
 */
function shouldEnableBarLaunchGrace(selected, safeAim, world) {
    if (!selected || !safeAim) return false;

    const minDy = (FLOAT_BAR.LAUNCH_GRACE_MIN_DY !== undefined) ? FLOAT_BAR.LAUNCH_GRACE_MIN_DY : -2;
    const minSlope = (FLOAT_BAR.LAUNCH_GRACE_MIN_SLOPE !== undefined) ? FLOAT_BAR.LAUNCH_GRACE_MIN_SLOPE : 0.22;

    if (safeAim.y < minDy) {
        return false;
    }
    // LAUNCH_GRACE_MIN_DY が正値指定の場合のみ従来の下向き勾配制限を適用（-2 緩和時は浅い端狙いも保護）
    if (minDy > 0 && safeAim.y < minSlope * Math.abs(safeAim.x)) {
        return false;
    }

    // 進行方向すぐ隣に同じ数字の待機ゼリーがある場合は合体機会を奪わないようすり抜け保護をオフにする
    if (world) {
        const selCentroid = selected.centroid || getSoftBodyCentroid(selected);
        if (selCentroid) {
            const selExt = getSoftBodyHalfExtents(selected);
            const dirX = safeAim.x >= 0 ? 1 : -1;
            const floating = getFloatingJellies(world);

            for (let i = 0; i < floating.length; i++) {
                const other = floating[i];
                if (!other || other === selected || other.jellyValue !== selected.jellyValue) continue;
                const otherCentroid = other.centroid || getSoftBodyCentroid(other);
                if (!otherCentroid) continue;

                const dx = otherCentroid.x - selCentroid.x;
                if (dx * dirX < -4) continue;

                const otherExt = getSoftBodyHalfExtents(other);
                const maxMatchDist = selExt.halfWidth + otherExt.halfWidth + 22;
                if (Math.abs(dx) <= maxMatchDist) {
                    return false;
                }
            }
        }
    }

    return true;
}

/**
 * 選択中のSoboの現在重心と最新ポインタ座標から、エイム矢印およびホップ予測軌道を更新する
 * （本家v1.2準拠：バー上でSoboが横移動しても初期オフセットを維持して指先方向へ追従。
 *   ドラッグ開始直後の様子見中はゼリー横移動分をオフセット吸収して勝手な矢印伸長を防止）
 * @param {Matter.Engine|null} engine - Matter.js物理エンジン
 * @param {Object} gameState - ゲーム状態オブジェクト
 * @param {number} pointerX - 最新ポインタ論理X座標
 * @param {number} pointerY - 最新ポインタ論理Y座標
 */
export function syncAimToPointer(engine, gameState, pointerX, pointerY) {
    if (!gameState) return;
    const selected = gameState.selectedJelly;

    if (!selected || selected.isMerging || !selected.isFloating) {
        resetAimState(gameState);
        return;
    }

    const centroid = getSoftBodyCentroid(selected);
    if (!centroid) {
        resetAimState(gameState);
        return;
    }

    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 22;

    // 長押し様子見対策：ドラッグ開始直後（!hasDraggedOut かつポインタ自身の移動距離が小さい間）は
    // ゼリーの横移動に dragOffset を追従させ、指静止中に勝手に逆方向へ矢印が伸びるのを防止
    if (!gameState.hasDraggedOut &&
        gameState.dragPointerStartX !== undefined &&
        gameState.dragPointerStartY !== undefined) {
        const ptrDx = pointerX - gameState.dragPointerStartX;
        const ptrDy = pointerY - gameState.dragPointerStartY;
        if ((ptrDx * ptrDx + ptrDy * ptrDy) < cancelRadius * cancelRadius) {
            gameState.dragOffsetX = gameState.dragPointerStartX - centroid.x;
            gameState.dragOffsetY = gameState.dragPointerStartY - centroid.y;
        }
    }

    const rawDx = pointerX - (centroid.x + gameState.dragOffsetX);
    const rawDy = pointerY - (centroid.y + gameState.dragOffsetY);
    const clamped = clampAimVector(rawDx, rawDy);
    const dist = Math.sqrt(clamped.x * clamped.x + clamped.y * clamped.y);

    // 一度でもキャンセル半径外へ伸ばしたかを記録（「そっと落とし」と「中心戻しキャンセル」の判別用）
    if (dist >= cancelRadius) {
        gameState.hasDraggedOut = true;
    }

    // 上向きドラッグ（dy < HOP_TRIGGER_DY かつ角度勾配 -dy > |dx| * HOP_TRIGGER_SLOPE）で自動的に「2.5D上段飛び越えホップ」モードへ切替
    if (isHopDirection(clamped.x, clamped.y, dist)) {
        gameState.isHopAim = true;
        const hopVel = computeHopVelocity(clamped.x, clamped.y);
        updateHopPreviewPoints(engine, gameState, selected, centroid, hopVel);
    } else {
        gameState.isHopAim = false;
        if (Array.isArray(gameState.hopPreviewPoints)) {
            gameState.hopPreviewPoints.length = 0;
        }
    }

    gameState.dragStartX = centroid.x;
    gameState.dragStartY = centroid.y;
    gameState.dragCurrentX = centroid.x + clamped.x;
    gameState.dragCurrentY = centroid.y + clamped.y;
    gameState.dragVectorX = clamped.x;
    gameState.dragVectorY = clamped.y;
}

/**
 * ドラッグ／タップ開始処理：上段バー領域限定の横長カプセル実幅対応タップ選択を行う
 * @param {Matter.World} world - Matter.js物理世界
 * @param {Object} gameState - ゲーム状態オブジェクト
 * @param {number} startX - タップ開始論理X座標
 * @param {number} startY - タップ開始論理Y座標
 * @returns {boolean} いずれかの上段ゼリーを選択できた場合は true
 */
export function startAimDrag(world, gameState, startX, startY) {
    if (!world || !gameState || gameState.isGameOver || !gameState.canDrop) return false;

    // 音量 ON 状態であれば、別アプリ・他画面復帰後でも確実にオーディオが稼働している状態を保証
    ensureAudioRunning();

    // 【誤タップ暴発の完全根絶】
    // 上段バー領域（Y <= FLOAT_BAR.Y + TAP_SELECT_Y_MARGIN）以外の盤面下部タップは無視する
    const maxSelectY = FLOAT_BAR.Y + (FLOAT_BAR.TAP_SELECT_Y_MARGIN || 75);
    if (startY > maxSelectY) return false;

    const floating = getFloatingJellies(world);
    if (floating.length === 0) return false;

    const extraMargin = FLOAT_BAR.TAP_SELECT_EXTRA_RADIUS || 28;
    let closest = null;
    let closestCentroid = null;
    let closestSurfaceDist = Infinity;

    // 横長カプセル実幅（getSoftBodyHalfExtents）に基づくカプセル外縁距離判定
    // 横長に伸びた 16 / 32 / 64 の左右端をタップしても正確かつ自然に捕捉できる
    for (let i = 0; i < floating.length; i++) {
        const comp = floating[i];
        const centroid = getSoftBodyCentroid(comp);
        if (!centroid) continue;

        const ext = getSoftBodyHalfExtents(comp);
        const halfW = ext.halfWidth || comp.targetRadius || 25.5;
        const halfH = ext.halfHeight || comp.targetRadius || 25.5;
        const straightHalf = Math.max(0, halfW - halfH);

        // 横長カプセルの水平中心線分上における最近傍点を算出
        const axisMinX = centroid.x - straightHalf;
        const axisMaxX = centroid.x + straightHalf;
        const nearestAxisX = Math.max(axisMinX, Math.min(axisMaxX, startX));

        const dx = startX - nearestAxisX;
        const dy = startY - centroid.y;
        const distToAxis = Math.sqrt(dx * dx + dy * dy);
        // カプセル外縁からの符号付き距離（内部タップは負値、外縁外側は正値）
        const surfaceDist = distToAxis - halfH;

        if (surfaceDist <= extraMargin && surfaceDist < closestSurfaceDist) {
            closestSurfaceDist = surfaceDist;
            closest = comp;
            closestCentroid = centroid;
        }
    }

    if (!closest || !closestCentroid) return false;

    gameState.selectedJelly = closest;
    gameState.selectedJellyId = closest.jellyId;
    gameState.isDragging = true;
    gameState.hasDraggedOut = false;
    gameState.isHopAim = false;
    if (Array.isArray(gameState.hopPreviewPoints)) {
        gameState.hopPreviewPoints.length = 0;
    } else {
        gameState.hopPreviewPoints = [];
    }

    // クリック／タッチ開始ポインタ座標とSobo中心からの初期オフセットを保持（様子見吸収 ＆ v1.2準拠追従エイム用）
    gameState.dragPointerStartX = startX;
    gameState.dragPointerStartY = startY;
    gameState.dragOffsetX = startX - closestCentroid.x;
    gameState.dragOffsetY = startY - closestCentroid.y;
    gameState.dragStartX = closestCentroid.x;
    gameState.dragStartY = closestCentroid.y;
    gameState.dragCurrentX = closestCentroid.x;
    gameState.dragCurrentY = closestCentroid.y;
    gameState.dragVectorX = 0;
    gameState.dragVectorY = 0;

    // 上段ゼリー選択時の極小水球タッチ音（「ぷにっ」）を再生
    playSoundSelect(closest.jellyValue);

    return true;
}

/**
 * ドラッグ中更新処理：ポインタ移動に合わせて矢印とホップ予測軌道を更新する
 * @param {Matter.Engine|null} engine - Matter.js物理エンジン
 * @param {Object} gameState - ゲーム状態オブジェクト
 * @param {number} currentX - 現在の論理X座標
 * @param {number} currentY - 現在の論理Y座標
 */
export function updateAimDrag(engine, gameState, currentX, currentY) {
    if (!gameState || !gameState.isDragging) return;
    syncAimToPointer(engine, gameState, currentX, currentY);
}

/**
 * ドラッグ終了処理：キャンセル／2.5D上段飛び越えホップ／そっと落とし／通常ショットを確定実行する
 * @param {Object} gameState - ゲーム状態オブジェクト
 * @param {Function|null} [onLaunchedCallback] - 発射が成立した際に呼ばれるコールバック（クールダウン制御用）
 * @param {Matter.World|null} [world] - 進行方向隣の同数字隣接判定用の物理世界
 * @returns {boolean} 実際に発射（ホップ含む）が実行された場合は true
 */
export function endAimDrag(gameState, onLaunchedCallback = null, world = null) {
    if (!gameState || !gameState.isDragging) return false;

    const selected = gameState.selectedJelly;
    const hasDraggedOut = gameState.hasDraggedOut;
    const vecX = gameState.dragVectorX;
    const vecY = gameState.dragVectorY;

    // 選択・ドラッグ表示状態をクリア
    resetAimState(gameState);

    // 選択ゼリーが既に合体等で消えている場合は何もしない
    if (!selected || selected.isMerging || !selected.isFloating) {
        return false;
    }

    const dist = Math.sqrt(vecX * vecX + vecY * vecY);
    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 22;

    // 【操作判別】
    // 1. 一度外へ矢印を伸ばしてから中心へ戻して離した場合 → 発射キャンセル（消費しない）
    if (hasDraggedOut && dist < cancelRadius) {
        return false;
    }

    // 2. 上向きドラッグ（dy < HOP_TRIGGER_DY かつ角度勾配 -dy > |dx| * HOP_TRIGGER_SLOPE） → 「2.5D上段飛び越えホップ（下に落ちず自動再吸着）」
    if (isHopDirection(vecX, vecY, dist)) {
        const safeAim = clampAimVector(vecX, vecY);
        const hopVel = computeHopVelocity(safeAim.x, safeAim.y);
        playSoundHop();
        launchBarHop(selected, hopVel);
    } else {
        // 3. タップして外へ伸ばさず離した場合 → 「そっと落とし」（加算初速 0）
        // 4. 水平〜下方向へ伸ばして離した場合 → 「通常ショット（端狙い・斜め下すり抜け保護付き加算速度発射）」
        let addVelocity = { x: 0, y: 0 };
        let useBarGrace = false;
        let powerRatio = 0;
        if (dist >= cancelRadius) {
            const safeAim = clampAimVector(vecX, vecY);
            const forceMult = (PHYSICS.AIM_FORCE_MULTIPLIER !== undefined) ? PHYSICS.AIM_FORCE_MULTIPLIER : 0.056;
            const baseMaxDrag = Math.max(cancelRadius + 1, PHYSICS.AIM_MAX_DRAG || 120);
            const downMaxDrag = Math.max(baseMaxDrag, PHYSICS.AIM_MAX_DRAG_DOWN || 170);
            const safeDist = Math.sqrt(safeAim.x * safeAim.x + safeAim.y * safeAim.y);

            // 全方向共通基準（AIM_MAX_DRAG: 120）による等方スカラー倍率（角度ズレ 0.000度・同一長さ＝同一初速）
            const baseP = Math.max(0, Math.min(1, (safeDist - cancelRadius) / (baseMaxDrag - cancelRadius)));
            const powerScale = 0.78 + 0.22 * baseP;
            const scaledMult = forceMult * powerScale;
            addVelocity = {
                x: safeAim.x * scaledMult,
                y: safeAim.y * scaledMult
            };

            // 全方向で勢いと水音のキレを一致させる発射初速ベース統一 powerRatio
            const launchSpeed = Math.sqrt(addVelocity.x * addVelocity.x + addVelocity.y * addVelocity.y);
            const maxDownSpeed = Math.max(0.001, downMaxDrag * forceMult);
            powerRatio = Math.max(0, Math.min(1, launchSpeed / maxDownSpeed));

            useBarGrace = shouldEnableBarLaunchGrace(selected, safeAim, world);
        }
        playSoundShoot(powerRatio);
        launchFloatingJelly(selected, addVelocity, useBarGrace);
    }

    gameState.lastFloatSpawnTime = Date.now();

    if (typeof onLaunchedCallback === 'function') {
        onLaunchedCallback();
    }

    return true;
}