/**
 * aim.js
 * @version v5.0 (Final Overhaul & Refactoring Step 7 - New Module)
 * @changes
 *   - リファクタリング分離として、main.js から上段タップ選択・360度順方向ダイレクトエイム・上段ホップ自動切替・放物線予測ドット算出・発射／キャンセル確定処理を独立モジュール化
 *   - 上段フロートバーの横長カプセル形状に対応し、getSoftBodyHalfExtents() を用いたカプセル中心線分距離ベースの上段限定タップ選択へ刷新（横長に伸びた 16〜64 の両端タップも正確に捕捉）
 *   - 2.5D飛び越えレーン方式ホップの物理定数（HOP_GRAVITY_SCALE: 0.62 / HOP_MIN_AIR_MS: 115 / HOP_MIN_UP_SPEED: 1.9）と完全同期した、左右壁＆天井クッション反射込みの放物線予測ドット計算を実装
 *   - GRAVITYキャッシュ不整合対策として constants.js / softbody.js / floatbar.js の絶対パスを ?v=5 へ統一（sound.js は既存安定版 ?v=4 を維持）
 * 
 * 上段フロートバーのゼリー選択、360度順方向ダイレクトエイム、
 * 2.5D上段飛び越えホップ自動切替および放物線軌道プレビュー計算を担う操作モジュール
 */

import { GAME_WIDTH, PHYSICS, FLOAT_BAR } from '/sobosuba/constants.js?v=5';
import {
    getSoftBodyCentroid,
    getSoftBodyHalfExtents,
    launchFloatingJelly,
    launchBarHop
} from '/sobosuba/softbody.js?v=5';
import { getFloatingJellies } from '/sobosuba/floatbar.js?v=5';
import { initSound, playSoundShoot, playSoundHop } from '/sobosuba/sound.js?v=4';

// ==========================================
// ホップ軌道プレビュー計算用の事前確保スクラッチバッファ（GC負荷削減）
// ==========================================
const HOP_PREVIEW_DOT_COUNT = 7;
const hopTraceScratchX = [];
const hopTraceScratchY = [];

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
 * ドラッグベクトルを最大ドラッグ距離でクランプする（上向き角度制限なし・360度解放）
 * @param {number} dx - X方向ドラッグ量
 * @param {number} dy - Y方向ドラッグ量
 * @returns {{ x: number, y: number }} クランプ済みベクトル
 */
export function clampAimVector(dx, dy) {
    let vecX = dx;
    let vecY = dy;
    const rawDist = Math.sqrt(vecX * vecX + vecY * vecY);
    const maxDrag = PHYSICS.AIM_MAX_DRAG || 150;

    if (rawDist > maxDrag) {
        const ratio = maxDrag / rawDist;
        vecX *= ratio;
        vecY *= ratio;
    }

    return { x: vecX, y: vecY };
}

/**
 * 上向きドラッグベクトルから「2.5D上段飛び越えホップ（Bar-Hop）」用の初速ベクトルを算出する
 * @param {number} vecX - クランプ済みX方向ドラッグ量
 * @param {number} vecY - クランプ済みY方向ドラッグ量
 * @returns {{ x: number, y: number }} ホップ初速ベクトル（px/substep 単位）
 */
export function computeHopVelocity(vecX, vecY) {
    const mult = FLOAT_BAR.HOP_FORCE_MULTIPLIER || 0.026;
    const minUpSpeed = FLOAT_BAR.HOP_MIN_UP_SPEED || 1.9;
    const maxHopSpeed = Math.min(
        FLOAT_BAR.HOP_MAX_SPEED || 3.9,
        PHYSICS.MAX_PARTICLE_SPEED || 4.5
    );

    let vx = vecX * mult;
    let vy = vecY * mult;

    // 隣の塊を確実に飛び越えられる最小上向き初速を保証
    if (vy > -minUpSpeed) {
        vy = -minUpSpeed;
    }

    const speedSq = vx * vx + vy * vy;
    if (speedSq > maxHopSpeed * maxHopSpeed) {
        const scale = maxHopSpeed / Math.sqrt(speedSq);
        vx *= scale;
        vy *= scale;
    }

    return { x: vx, y: vy };
}

/**
 * 2.5D上段飛び越えホップ時の放物線予測ドット（左右壁・天井反射込み、着地先まで7点）を
 * softbody.js / physics.js の物理定数と同期して算出する
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

    // launchBarHop() と同様に現在のバー上横移動速度の40%を加味
    let avgVx = 0;
    const pts = selected.particles;
    if (pts && pts.length > 0) {
        for (let i = 0; i < pts.length; i++) {
            avgVx += pts[i].velocity.x;
        }
        avgVx /= pts.length;
    }

    const maxHopSpeed = Math.min(
        FLOAT_BAR.HOP_MAX_SPEED || 3.9,
        PHYSICS.MAX_PARTICLE_SPEED || 4.5
    );
    let vx = avgVx * 0.4 + hopVel.x;
    let vy = hopVel.y;
    const initSpeedSq = vx * vx + vy * vy;
    if (initSpeedSq > maxHopSpeed * maxHopSpeed) {
        const s = maxHopSpeed / Math.sqrt(initSpeedSq);
        vx *= s;
        vy *= s;
    }

    // ホップ飛行中は横長カプセルから円形へモーフィングするため、円形基準半径で壁・天井反射を見積もる
    const r = selected.targetRadius || 21;
    const substeps = Math.max(1, PHYSICS.SUBSTEPS || 4);
    const subDelta = (1000 / 60) / substeps;
    const gravityY = engine ? engine.gravity.y : PHYSICS.GRAVITY_Y;
    const gravityScale = engine ? engine.gravity.scale : 0.001;
    const hopGravScale = (FLOAT_BAR.HOP_GRAVITY_SCALE !== undefined) ? FLOAT_BAR.HOP_GRAVITY_SCALE : 0.62;
    const subAccY = gravityY * gravityScale * hopGravScale * subDelta * subDelta;
    const airDamp = 1 - (PHYSICS.FRICTION_AIR || 0.004);
    const minAirSteps = Math.ceil((FLOAT_BAR.HOP_MIN_AIR_MS || 115) / subDelta);
    const targetBarY = FLOAT_BAR.Y;

    let px = centroid.x;
    let py = centroid.y;

    hopTraceScratchX.length = 0;
    hopTraceScratchY.length = 0;

    const maxSimSteps = 260;
    for (let step = 1; step <= maxSimSteps; step++) {
        vx *= airDamp;
        vy = vy * airDamp + subAccY;
        px += vx;
        py += vy;

        // 左右壁・天井クッションの反射シミュレーション（physics.js の天井反発係数 0.45 と同期）
        if (px < r) {
            px = r;
            vx = Math.abs(vx) * 0.55;
        } else if (px > GAME_WIDTH - r) {
            px = GAME_WIDTH - r;
            vx = -Math.abs(vx) * 0.55;
        }
        if (py < r) {
            py = r;
            vy = Math.abs(vy) * 0.45;
        }

        hopTraceScratchX.push(px);
        hopTraceScratchY.push(py);

        // 下降フェーズでバー高度へ到達したら自動再吸着（リキャッチ）予定位置として終了
        if (step >= minAirSteps && vy >= 0 && py >= targetBarY) {
            hopTraceScratchY[hopTraceScratchY.length - 1] = targetBarY;
            break;
        }
    }

    const total = hopTraceScratchX.length;
    if (total === 0) return;

    // 放物線軌道から均等に7点（末尾は必ず予測着地位置）をサンプリング
    const dotCount = Math.min(HOP_PREVIEW_DOT_COUNT, total);
    for (let k = 1; k <= dotCount; k++) {
        const idx = Math.min(total - 1, Math.max(0, Math.round((k / dotCount) * (total - 1))));
        out.push({
            x: hopTraceScratchX[idx],
            y: hopTraceScratchY[idx]
        });
    }
}

/**
 * 選択中のSoboの現在重心と最新ポインタ座標から、エイム矢印およびホップ予測軌道を更新する
 * （本家v1.2準拠：バー上でSoboが横移動しても初期オフセットを維持して指先方向へ追従）
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

    const rawDx = pointerX - (centroid.x + gameState.dragOffsetX);
    const rawDy = pointerY - (centroid.y + gameState.dragOffsetY);
    const clamped = clampAimVector(rawDx, rawDy);
    const dist = Math.sqrt(clamped.x * clamped.x + clamped.y * clamped.y);
    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 22;
    const hopTriggerDy = (FLOAT_BAR.HOP_TRIGGER_DY !== undefined) ? FLOAT_BAR.HOP_TRIGGER_DY : -12;

    // 一度でもキャンセル半径外へ伸ばしたかを記録（「そっと落とし」と「中心戻しキャンセル」の判別用）
    if (dist >= cancelRadius) {
        gameState.hasDraggedOut = true;
    }

    // 上向きドラッグ（dy < HOP_TRIGGER_DY）で自動的に「2.5D上段飛び越えホップ」モードへ切替
    if (dist >= cancelRadius && clamped.y < hopTriggerDy) {
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

    // サウンド機能の初期化（ブラウザ制約により初回ユーザー操作時にアクティブ化）
    initSound();

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
        const halfW = ext.halfWidth || comp.targetRadius || 21;
        const halfH = ext.halfHeight || comp.targetRadius || 21;
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

    // クリック／タッチしたSobo中心からの初期オフセットを保持（v1.2準拠の追従エイム用）
    gameState.dragOffsetX = startX - closestCentroid.x;
    gameState.dragOffsetY = startY - closestCentroid.y;
    gameState.dragStartX = closestCentroid.x;
    gameState.dragStartY = closestCentroid.y;
    gameState.dragCurrentX = closestCentroid.x;
    gameState.dragCurrentY = closestCentroid.y;
    gameState.dragVectorX = 0;
    gameState.dragVectorY = 0;

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
 * @returns {boolean} 実際に発射（ホップ含む）が実行された場合は true
 */
export function endAimDrag(gameState, onLaunchedCallback = null) {
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
    const hopTriggerDy = (FLOAT_BAR.HOP_TRIGGER_DY !== undefined) ? FLOAT_BAR.HOP_TRIGGER_DY : -12;

    // 【操作判別】
    // 1. 一度外へ矢印を伸ばしてから中心へ戻して離した場合 → 発射キャンセル（消費しない）
    if (hasDraggedOut && dist < cancelRadius) {
        return false;
    }

    // 2. 上向きドラッグ（dy < HOP_TRIGGER_DY） → 「2.5D上段飛び越えホップ（下に落ちず自動再吸着）」
    if (dist >= cancelRadius && vecY < hopTriggerDy) {
        const safeAim = clampAimVector(vecX, vecY);
        const hopVel = computeHopVelocity(safeAim.x, safeAim.y);
        playSoundHop();
        launchBarHop(selected, hopVel);
    } else {
        // 3. タップして外へ伸ばさず離した場合 → 「そっと落とし」（加算初速 0）
        // 4. 水平〜下方向へ伸ばして離した場合 → 「通常ショット（加算速度発射）」
        let addVelocity = { x: 0, y: 0 };
        if (dist >= cancelRadius) {
            const safeAim = clampAimVector(vecX, vecY);
            addVelocity = {
                x: safeAim.x * PHYSICS.AIM_FORCE_MULTIPLIER,
                y: safeAim.y * PHYSICS.AIM_FORCE_MULTIPLIER
            };
        }
        playSoundShoot();
        launchFloatingJelly(selected, addVelocity);
    }

    gameState.lastFloatSpawnTime = Date.now();

    if (typeof onLaunchedCallback === 'function') {
        onLaunchedCallback();
    }

    return true;
}