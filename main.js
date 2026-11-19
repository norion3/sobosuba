/**
 * main.js
 * @version v4.0 (Final Overhaul Step 9 - Final Integration)
 * @changes
 *   - 画面下部の誤タップ暴発を完全根絶するため、タップ選択を上段バー領域（Y <= FLOAT_BAR.Y + TAP_SELECT_Y_MARGIN）かつゼリー近傍（半径 + TAP_SELECT_EXTRA_RADIUS）に限定
 *   - 上向き角度制限を撤廃して360度エイムを解放し、上向きドラッグ（dy < FLOAT_BAR.HOP_TRIGGER_DY）で「上段飛び越えホップ（launchBarHop）」へ自動切替・playSoundHop()再生・放物線予測ドット（hopPreviewPoints）算出を実装
 *   - 本家スコア帯に合わせて出現テーブル（generateNextValue）の解禁閾値と後半の1出現率を適正化し、initFloatBar() で隣接する数字が重複しない初期配置へ修正
 *   - ゲームオーバー確定時に即暗転させず、ザップ音再生後に 0.5 秒（UI.GAME_OVER_DELAY_MS）の余韻ウェイトを挟んで押し込み箇所を確認してからリザルト画面へ遷移するよう統合
 *   - ホップ滞空中のSoboも上段所属としてカウント・空き検知へ反映し、GRAVITYキャッシュ不整合対策として全モジュールの絶対パスインポートを ?v=4 へ統一
 * 
 * sobosuba風パズル（中空ビーズリング・ソフトボディ版）のマスター統合モジュール
 * 
 * GRAVITY規格に準拠するため、全てのモジュールを絶対パスでインポートし、
 * Matter.jsのサブステップ物理シミュレーション、上部フロートバー管理、
 * 順方向ダイレクトエイム／上段飛び越えホップ、および描画ループを統合・管理します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, UI, JELLY_CONFIG, PHYSICS, FLOAT_BAR } from '/sobosuba/constants.js?v=4';
import { initPhysics, stepPhysics, updateBumpers, leftBumper, rightBumper } from '/sobosuba/physics.js?v=4';
import { createSoftBodyJelly, getSoftBodyCentroid, launchFloatingJelly, launchBarHop, updateSoftBodies } from '/sobosuba/softbody.js?v=4';
import { handleCollisions, handleMerges, resetMergeQueues } from '/sobosuba/jelly.js?v=4';
import { initUI, applyViewportSize, getCanvasStageElement, updateScoreUI, showGameOverUI, hideGameOverUI, setWarningEffect } from '/sobosuba/dom_ui.js?v=4';
import { initInput, getPointerState, updateScale } from '/sobosuba/input.js?v=4';
import { renderGame } from '/sobosuba/render.js?v=4';
import { initSound, playSoundShoot, playSoundHop, playSoundGameOverZap } from '/sobosuba/sound.js?v=4';

// ==========================================
// グローバル変数・ゲームステート
// ==========================================
let engine;
let world;
let canvas;
let ctx;
let isBooted = false;
let lastFrameTime = 0;
let dropCooldownTimer = null;
let gameOverTimer = null;

// ホップ軌道プレビュー計算用の事前確保スクラッチバッファ（GC負荷削減）
const HOP_PREVIEW_DOT_COUNT = 7;
const hopTraceScratchX = [];
const hopTraceScratchY = [];

const gameState = {
    score: 0,
    isGameOver: false,
    canDrop: true,
    frameCount: 0,

    // 上部フロートバーの選択中ゼリー・スポーナー管理
    selectedJelly: null,
    selectedJellyId: null,
    lastFloatSpawnTime: 0,
    barEmptySince: 0,
    pendingSpawnValue: null,
    lastSpawnSide: 'right',

    // 順方向ダイレクトエイム ＆ 上段飛び越えホップ状態
    isDragging: false,
    hasDraggedOut: false,
    isHopAim: false,
    hopPreviewPoints: [],
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragStartX: 0,
    dragStartY: 0,
    dragCurrentX: 0,
    dragCurrentY: 0,
    dragVectorX: 0,
    dragVectorY: 0,

    // 描画用バンパー最新状態キャッシュ
    lastBumperState: {
        leftPressed: false,
        rightPressed: false
    }
};

// ==========================================
// ゲーム初期化・リセット処理
// ==========================================
function startGame() {
    // 進行中のタイマーが残っていればすべて解除
    if (dropCooldownTimer) {
        clearTimeout(dropCooldownTimer);
        dropCooldownTimer = null;
    }
    if (gameOverTimer) {
        clearTimeout(gameOverTimer);
        gameOverTimer = null;
    }

    // リトライ時のゴーストゼリー発生を防ぐため、前ゲームの合体キューを完全初期化
    resetMergeQueues();

    // 物理エンジンの初期化（超低摩擦の壁・天井クッション・底面角カット・上部左右バンパーの生成）
    const physics = initPhysics();
    engine = physics.engine;
    world = physics.world;

    // ステートのリセット
    gameState.score = 0;
    gameState.isGameOver = false;
    gameState.canDrop = true;
    gameState.frameCount = 0;
    gameState.selectedJelly = null;
    gameState.selectedJellyId = null;
    gameState.isDragging = false;
    gameState.hasDraggedOut = false;
    gameState.isHopAim = false;
    gameState.hopPreviewPoints.length = 0;
    gameState.dragOffsetX = 0;
    gameState.dragOffsetY = 0;
    gameState.dragVectorX = 0;
    gameState.dragVectorY = 0;
    gameState.lastFloatSpawnTime = Date.now();
    gameState.barEmptySince = 0;
    gameState.pendingSpawnValue = null;
    gameState.lastSpawnSide = 'right';
    gameState.lastBumperState = { leftPressed: false, rightPressed: false };
    lastFrameTime = 0;

    // UIのリセット
    updateScoreUI(gameState.score);
    hideGameOverUI();
    setWarningEffect(false);

    // 上部フロートバーへ初期ゼリーを生成（隣接重複なし）
    initFloatBar();

    // ==========================================
    // Matter.js イベントのバインド
    // ==========================================
    const applyCollisionScore = (earned) => {
        if (earned > 0) {
            // 本家完全準拠：未合体Soboが初めて合体に参加した分のみをそのまま加算
            gameState.score += earned;
            updateScoreUI(gameState.score);
        }
    };

    Matter.Events.on(engine, 'collisionStart', (event) => {
        applyCollisionScore(handleCollisions(event, true));
    });

    // 合体保護期間が明けた直後も接触し続けていた同数字同士を確実に取りこぼさず合体させる
    Matter.Events.on(engine, 'collisionActive', (event) => {
        applyCollisionScore(handleCollisions(event, false));
    });

    Matter.Events.on(engine, 'afterUpdate', () => {
        // 物理演算後に、合体キューに入ったソフトボディの破棄と再構築を安全に行う
        handleMerges(world);
    });
}

// ==========================================
// 上部フロートバー（本家スコア帯準拠テーブル・左右2点スポーナー・セーフティスポーン）
// ==========================================
function generateNextValue() {
    const rand = Math.random();
    const s = gameState.score;

    // 本家スコア方式（盤面有効値総和）の進行速度に最適化した出現テーブル
    if (s >= 700) {
        if (rand > 0.92) return 16; // 8%
        if (rand > 0.80) return 8;  // 12%
        if (rand > 0.58) return 4;  // 22%
        if (rand > 0.28) return 2;  // 30%
        return 1;                   // 28%
    }
    if (s >= 250) {
        if (rand > 0.88) return 8;  // 12%
        if (rand > 0.68) return 4;  // 20%
        if (rand > 0.34) return 2;  // 34%
        return 1;                   // 34%
    }
    if (s >= 80) {
        if (rand > 0.78) return 4;  // 22%
        if (rand > 0.38) return 2;  // 40%
        return 1;                   // 38%
    }
    return rand > 0.45 ? 2 : 1;     // 序盤：2(55%) / 1(45%)
}

/**
 * 現在上部フロートバー上に浮いている全ゼリーを取得する（中空ビーズリング対応）
 */
function getFloatingJellies() {
    if (!world) return [];
    const composites = world.composites || Matter.Composite.allComposites(world);
    const list = [];
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp &&
            comp.label === 'jelly_composite' &&
            comp.isFloating &&
            !comp.isMerging &&
            comp.particles &&
            comp.particles.length > 0) {
            list.push(comp);
        }
    }
    return list;
}

/**
 * 現在上段飛び越えホップ滞空中のゼリー数を取得する
 */
function getBarHoppingCount() {
    if (!world) return 0;
    const composites = world.composites || Matter.Composite.allComposites(world);
    let count = 0;
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp &&
            comp.label === 'jelly_composite' &&
            comp.isBarHopping &&
            !comp.isMerging) {
            count++;
        }
    }
    return count;
}

/**
 * スポーナーのクリアランス検知および重なり爆発防止のため、バー領域に存在する全ゼリーを取得する
 */
function getBarAreaJellies(newRadius) {
    if (!world) return [];
    const composites = world.composites || Matter.Composite.allComposites(world);
    const list = [];
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp && comp.label === 'jelly_composite' && comp.particles && comp.particles.length > 0) {
            const centroid = getSoftBodyCentroid(comp);
            if (!centroid) continue;
            const otherR = comp.targetRadius || 16;
            const dy = Math.abs(centroid.y - FLOAT_BAR.Y);
            if (comp.isFloating || comp.isBarHopping || dy < (otherR + newRadius + 14)) {
                list.push({ comp, cx: centroid.x, cy: centroid.y, r: otherR });
            }
        }
    }
    return list;
}

/**
 * 指定された出現X座標における周囲ゼリーとの最小クリアランス（外縁同士の空き距離）を算出する
 */
function calcSpawnClearance(spawnX, r, barAreaJellies) {
    const minX = FLOAT_BAR.PADDING_X + r;
    const maxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - r;
    if (spawnX < minX - 1 || spawnX > maxX + 1) return -Infinity;

    let minClearance = Infinity;
    for (let i = 0; i < barAreaJellies.length; i++) {
        const other = barAreaJellies[i];
        const dx = spawnX - other.cx;
        const dy = FLOAT_BAR.Y - other.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const clearance = dist - (r + other.r);
        if (clearance < minClearance) {
            minClearance = clearance;
        }
    }
    return minClearance;
}

/**
 * ゲーム開始時に上部フロートバーへ初期ゼリーを配置する
 * 開始直後の意図せぬ自動合体を防ぐため、隣接する数字が重複しないように生成する
 */
function initFloatBar() {
    const count = Math.min(4, FLOAT_BAR.MAX_COUNT || 5);
    const values = [];
    const radii = [];
    let sumDiameters = 0;

    for (let i = 0; i < count; i++) {
        let val = generateNextValue();
        // 直前のゼリーと同じ数字になった場合は別値へ切り替えて開始直後の勝手な合体を防止
        if (i > 0 && val === values[i - 1]) {
            val = (val === 1) ? 2 : 1;
        }
        const config = JELLY_CONFIG[val] || JELLY_CONFIG[1];
        values.push(val);
        radii.push(config.radius);
        sumDiameters += config.radius * 2;
    }

    const gap = 8;
    const usableWidth = GAME_WIDTH - FLOAT_BAR.PADDING_X * 2;
    const totalWidth = sumDiameters + (count - 1) * gap;
    const scaleRatio = totalWidth > usableWidth ? (usableWidth / totalWidth) : 1;
    const actualTotalWidth = totalWidth * scaleRatio;

    let cursorX = (GAME_WIDTH - actualTotalWidth) / 2;

    for (let i = 0; i < count; i++) {
        const r = radii[i];
        const minX = FLOAT_BAR.PADDING_X + r;
        const maxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - r;
        const rawX = cursorX + r * scaleRatio;
        const clampedX = Math.max(minX, Math.min(maxX, rawX));

        // 初期スポーンは未合体（hasMerged = false）として生成
        const comp = createSoftBodyJelly(clampedX, FLOAT_BAR.Y, values[i], null, true, false);
        Matter.Composite.add(world, comp);

        cursorX += (r * 2 + gap) * scaleRatio;
    }
}

/**
 * 本家準拠：左右2箇所のスポーナーが空き距離（クリアランス）を検知して補充し、
 * 両端閉塞かつバーが空の状態が続いた場合はセーフティスポーンで詰みを防ぐ
 */
function maintainFloatBar() {
    if (gameState.isGameOver || !world) return;

    const now = Date.now();
    const floating = getFloatingJellies();
    const hoppingCount = getBarHoppingCount();
    const barOwnedCount = floating.length + hoppingCount;

    // バーが空になってからの経過時間を追跡（ホップ滞空中は空とみなさない）
    if (barOwnedCount === 0) {
        if (gameState.barEmptySince === 0) {
            gameState.barEmptySince = now;
        }
    } else {
        gameState.barEmptySince = 0;
    }

    if (barOwnedCount >= FLOAT_BAR.MAX_COUNT) return;
    if (now - gameState.lastFloatSpawnTime < FLOAT_BAR.SPAWN_DELAY_MS) return;

    // 次に補充する数値が未決定なら抽選して保持（空き待ち中の値ブレを防止）
    if (gameState.pendingSpawnValue === null) {
        gameState.pendingSpawnValue = generateNextValue();
    }

    const val = gameState.pendingSpawnValue;
    const config = JELLY_CONFIG[val] || JELLY_CONFIG[1];
    const r = config.radius;
    const clearanceMargin = FLOAT_BAR.SPAWN_CLEARANCE_MARGIN || 6;
    const entrySpeed = FLOAT_BAR.SPAWN_ENTRY_VELOCITY || 0.55;
    const barAreaJellies = getBarAreaJellies(r);

    // 左右2点スポーナーの基準X座標（壁へめり込まないよう半径を考慮）
    const leftSpawnX = Math.max(FLOAT_BAR.LEFT_SPAWN_X || (FLOAT_BAR.PADDING_X + r), FLOAT_BAR.PADDING_X + r);
    const rightSpawnX = Math.min(FLOAT_BAR.RIGHT_SPAWN_X || (GAME_WIDTH - FLOAT_BAR.PADDING_X - r), GAME_WIDTH - FLOAT_BAR.PADDING_X - r);

    const leftClearance = calcSpawnClearance(leftSpawnX, r, barAreaJellies);
    const rightClearance = calcSpawnClearance(rightSpawnX, r, barAreaJellies);

    const canSpawnLeft = leftClearance >= clearanceMargin;
    const canSpawnRight = rightClearance >= clearanceMargin;

    let chosenSide = null;
    if (canSpawnLeft && canSpawnRight) {
        // 双方に十分な空きがある場合は、クリアランスに大差がなければ左右交互に送り出す
        if (Math.abs(leftClearance - rightClearance) > 12) {
            chosenSide = leftClearance > rightClearance ? 'left' : 'right';
        } else {
            chosenSide = gameState.lastSpawnSide === 'left' ? 'right' : 'left';
        }
    } else if (canSpawnLeft) {
        chosenSide = 'left';
    } else if (canSpawnRight) {
        chosenSide = 'right';
    }

    if (chosenSide !== null) {
        const spawnX = chosenSide === 'left' ? leftSpawnX : rightSpawnX;
        const entryVel = {
            x: chosenSide === 'left' ? entrySpeed : -entrySpeed,
            y: 0
        };
        const newComp = createSoftBodyJelly(spawnX, FLOAT_BAR.Y, val, entryVel, true, false);
        Matter.Composite.add(world, newComp);

        gameState.lastSpawnSide = chosenSide;
        gameState.lastFloatSpawnTime = now;
        gameState.pendingSpawnValue = null;
        gameState.barEmptySince = 0;
        return;
    }

    // ==========================================
    // セーフティスポーン（本家救済仕様）
    // 下の塊で左右両スポーナーが塞がれ、バー上が0個のまま一定時間経過したら強制補充
    // ==========================================
    const safetyDelay = FLOAT_BAR.SAFETY_SPAWN_DELAY_MS || 1500;
    if (barOwnedCount === 0 && gameState.barEmptySince > 0 && (now - gameState.barEmptySince) >= safetyDelay) {
        // バー幅の中から最もクリアランスが大きい安全位置を選んで強制生成
        const minX = FLOAT_BAR.PADDING_X + r;
        const maxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - r;
        let bestX = GAME_WIDTH / 2;
        let bestClearance = -Infinity;
        const samples = 9;

        for (let s = 0; s < samples; s++) {
            const candX = minX + ((maxX - minX) * s) / (samples - 1);
            const c = calcSpawnClearance(candX, r, barAreaJellies);
            if (c > bestClearance) {
                bestClearance = c;
                bestX = candX;
            }
        }

        const safeComp = createSoftBodyJelly(bestX, FLOAT_BAR.Y, val, { x: 0, y: 0 }, true, false);
        Matter.Composite.add(world, safeComp);

        gameState.lastFloatSpawnTime = now;
        gameState.pendingSpawnValue = null;
        gameState.barEmptySince = 0;
    }
}

// ==========================================
// 順方向360度エイム ＆ 上段飛び越えホップ軌道計算
// ==========================================
/**
 * ドラッグベクトルを最大ドラッグ距離でクランプする（上向き角度制限を撤廃し360度解放）
 */
function clampAimVector(dx, dy) {
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
 * 上向きドラッグベクトルから「上段飛び越えホップ（Bar-Hop）」用の初速ベクトルを算出する
 */
function computeHopVelocity(vecX, vecY) {
    const mult = FLOAT_BAR.HOP_FORCE_MULTIPLIER || 0.026;
    const minUpSpeed = FLOAT_BAR.HOP_MIN_UP_SPEED || 1.85;
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
 * 上段飛び越えホップ時の放物線予測ドット（着地先まで6〜7点）を物理定数と同期して算出する
 */
function updateHopPreviewPoints(selected, centroid, hopVel) {
    const out = gameState.hopPreviewPoints;
    out.length = 0;
    if (!selected || !centroid || !hopVel) return;

    // launchBarHop と同様に現在のバー上横移動速度の40%を加味
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

    const r = selected.targetRadius || 16;
    const substeps = Math.max(1, PHYSICS.SUBSTEPS || 4);
    const subDelta = (1000 / 60) / substeps;
    const gravityY = engine ? engine.gravity.y : PHYSICS.GRAVITY_Y;
    const gravityScale = engine ? engine.gravity.scale : 0.001;
    const hopGravScale = (FLOAT_BAR.HOP_GRAVITY_SCALE !== undefined) ? FLOAT_BAR.HOP_GRAVITY_SCALE : 0.65;
    const subAccY = gravityY * gravityScale * hopGravScale * subDelta * subDelta;
    const airDamp = 1 - (PHYSICS.FRICTION_AIR || 0.004);
    const minAirSteps = Math.ceil((FLOAT_BAR.HOP_MIN_AIR_MS || 110) / subDelta);
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

        // 左右壁・天井クッションの簡易反射
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

        // 下降フェーズでバー高度へ到達したら着地先としてシミュレーション終了
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
 */
function syncAimToPointer(pointerX, pointerY) {
    const selected = gameState.selectedJelly;
    if (!selected || selected.isMerging || !selected.isFloating) {
        gameState.isDragging = false;
        gameState.hasDraggedOut = false;
        gameState.isHopAim = false;
        gameState.hopPreviewPoints.length = 0;
        gameState.selectedJelly = null;
        gameState.selectedJellyId = null;
        return;
    }

    const centroid = getSoftBodyCentroid(selected);
    if (!centroid) {
        gameState.isDragging = false;
        gameState.hasDraggedOut = false;
        gameState.isHopAim = false;
        gameState.hopPreviewPoints.length = 0;
        gameState.selectedJelly = null;
        gameState.selectedJellyId = null;
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

    // 上向きドラッグ（dy < HOP_TRIGGER_DY）で自動的に「上段飛び越えホップ」モードへ切替
    if (dist >= cancelRadius && clamped.y < hopTriggerDy) {
        gameState.isHopAim = true;
        const hopVel = computeHopVelocity(clamped.x, clamped.y);
        updateHopPreviewPoints(selected, centroid, hopVel);
    } else {
        gameState.isHopAim = false;
        gameState.hopPreviewPoints.length = 0;
    }

    gameState.dragStartX = centroid.x;
    gameState.dragStartY = centroid.y;
    gameState.dragCurrentX = centroid.x + clamped.x;
    gameState.dragCurrentY = centroid.y + clamped.y;
    gameState.dragVectorX = clamped.x;
    gameState.dragVectorY = clamped.y;
}

function handleDragStart(startX, startY) {
    if (gameState.isGameOver || !gameState.canDrop) return;

    // サウンド機能の初期化（ブラウザ制約により初回ユーザー操作時にアクティブ化）
    initSound();

    // 【誤タップ暴発の完全根絶】
    // 上段バー領域（Y <= FLOAT_BAR.Y + TAP_SELECT_Y_MARGIN）以外の盤面下部タップは無視する
    const maxSelectY = FLOAT_BAR.Y + (FLOAT_BAR.TAP_SELECT_Y_MARGIN || 75);
    if (startY > maxSelectY) return;

    // 上部フロートバー上のゼリーのうち、許容距離内にある最も近いゼリーのみ選択
    const floating = getFloatingJellies();
    if (floating.length === 0) return;

    const extraRadius = FLOAT_BAR.TAP_SELECT_EXTRA_RADIUS || 28;
    let closest = null;
    let closestCentroid = null;
    let closestDist = Infinity;

    for (let i = 0; i < floating.length; i++) {
        const comp = floating[i];
        const centroid = getSoftBodyCentroid(comp);
        if (!centroid) continue;

        const dx = startX - centroid.x;
        const dy = startY - centroid.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const selectLimit = (comp.targetRadius || 16) + extraRadius;

        if (dist <= selectLimit && dist < closestDist) {
            closestDist = dist;
            closest = comp;
            closestCentroid = centroid;
        }
    }

    if (!closest || !closestCentroid) return;

    gameState.selectedJelly = closest;
    gameState.selectedJellyId = closest.jellyId;
    gameState.isDragging = true;
    gameState.hasDraggedOut = false;
    gameState.isHopAim = false;
    gameState.hopPreviewPoints.length = 0;
    // クリック／タッチしたSobo中心からの初期オフセットを保持（v1.2準拠の追従エイム用）
    gameState.dragOffsetX = startX - closestCentroid.x;
    gameState.dragOffsetY = startY - closestCentroid.y;
    gameState.dragStartX = closestCentroid.x;
    gameState.dragStartY = closestCentroid.y;
    gameState.dragCurrentX = closestCentroid.x;
    gameState.dragCurrentY = closestCentroid.y;
    gameState.dragVectorX = 0;
    gameState.dragVectorY = 0;
}

function handleDragUpdate(currentX, currentY) {
    if (!gameState.isDragging) return;
    syncAimToPointer(currentX, currentY);
}

function handleDragEnd() {
    if (!gameState.isDragging) return;
    gameState.isDragging = false;

    const selected = gameState.selectedJelly;
    const hasDraggedOut = gameState.hasDraggedOut;
    const vecX = gameState.dragVectorX;
    const vecY = gameState.dragVectorY;

    gameState.selectedJelly = null;
    gameState.selectedJellyId = null;
    gameState.hasDraggedOut = false;
    gameState.isHopAim = false;
    gameState.hopPreviewPoints.length = 0;

    // 選択ゼリーが既に合体等で消えている場合は何もしない
    if (!selected || selected.isMerging || !selected.isFloating) {
        return;
    }

    const dist = Math.sqrt(vecX * vecX + vecY * vecY);
    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 22;
    const hopTriggerDy = (FLOAT_BAR.HOP_TRIGGER_DY !== undefined) ? FLOAT_BAR.HOP_TRIGGER_DY : -12;

    // 【操作判別】
    // 1. 一度外へ矢印を伸ばしてから中心へ戻して離した場合 → 発射キャンセル（消費しない）
    if (hasDraggedOut && dist < cancelRadius) {
        return;
    }

    // 2. 上向きドラッグ（dy < HOP_TRIGGER_DY） → 「上段飛び越えホップ（下に落ちず自動再吸着）」
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

    gameState.canDrop = false;
    if (dropCooldownTimer) clearTimeout(dropCooldownTimer);
    dropCooldownTimer = setTimeout(() => {
        dropCooldownTimer = null;
        if (!gameState.isGameOver) gameState.canDrop = true;
    }, UI.DROP_COOLDOWN_MS);
}

// ==========================================
// メインゲームループ (毎フレーム実行・4分割サブステップ物理駆動)
// ==========================================
function gameLoop(timestamp) {
    requestAnimationFrame(gameLoop);

    if (!engine) return;

    const nowTs = typeof timestamp === 'number' ? timestamp : performance.now();
    const deltaMs = lastFrameTime > 0 ? (nowTs - lastFrameTime) : (1000 / 60);
    lastFrameTime = nowTs;

    gameState.frameCount++;

    if (!gameState.isGameOver) {
        // 1. 4分割サブステップで物理演算および非侵入・面積保存ソフトボディを更新
        stepPhysics(deltaMs, () => {
            updateSoftBodies(world, engine);
        });

        // 2. ドラッグ中に選択Soboがバー上で横移動した場合も、毎フレーム指先方向へ矢印・軌道予測を追従
        if (gameState.isDragging) {
            const ptr = getPointerState();
            if (ptr && ptr.isDragging) {
                syncAimToPointer(ptr.currentX, ptr.currentY);
            }
        }

        // 3. 上部フロートバーの左右2点スポーナー＆セーフティスポーンを監視・補充
        maintainFloatBar();

        // 4. 左右バンパーの押し込み変位量および同時継続押し込み判定
        const bumperResult = updateBumpers(deltaMs);
        gameState.lastBumperState = {
            leftPressed: bumperResult.leftPressed,
            rightPressed: bumperResult.rightPressed
        };

        // 【ゲームオーバー判定】両側のバンパーが同時に一定時間（BUMPER.GAME_OVER_HOLD_MS）押し込まれた場合
        if (bumperResult.isGameOverTriggered) {
            gameState.isGameOver = true;
            gameState.canDrop = false;
            gameState.isDragging = false;
            gameState.hasDraggedOut = false;
            gameState.isHopAim = false;
            gameState.hopPreviewPoints.length = 0;
            gameState.selectedJelly = null;
            gameState.selectedJellyId = null;

            // 本家準拠のゲームオーバーザップ音を即座に再生し、押し込まれた盤面を0.5秒見せてからリザルト表示
            playSoundGameOverZap();
            setWarningEffect(true);

            const finalScoreSnapshot = gameState.score;
            const delayMs = UI.GAME_OVER_DELAY_MS || 500;
            if (gameOverTimer) clearTimeout(gameOverTimer);
            gameOverTimer = setTimeout(() => {
                gameOverTimer = null;
                if (gameState.isGameOver) {
                    setWarningEffect(false);
                    showGameOverUI(finalScoreSnapshot);
                }
            }, delayMs);
        } else {
            // 片側だけ押し込まれた場合は、UIレイヤーに警告エフェクト(赤点滅)を指示
            setWarningEffect(bumperResult.leftPressed || bumperResult.rightPressed);
        }
    }

    // 描画モジュールへ渡すバンパー状態
    const renderBumperState = {
        leftBumper,
        rightBumper,
        leftPressed: gameState.lastBumperState.leftPressed,
        rightPressed: gameState.lastBumperState.rightPressed
    };

    // Canvasへのレンダリング
    renderGame(ctx, world, gameState, renderBumperState);
}

// ==========================================
// 画面サイズ自動取得・縦横自動調整 ＆ GRAVITY即時起動シーケンス
// ==========================================
function handleResize() {
    if (!canvas) return;

    // 1. visualViewport（未対応時は window.innerWidth / innerHeight）から実表示領域を自動取得
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;
    const offsetTop = vv ? vv.offsetTop : 0;
    const offsetLeft = vv ? vv.offsetLeft : 0;

    // コンテナサイズを実ビューポートへ同期（GRAVITYヘッダー帯・下部余白を自動確保）
    applyViewportSize(vw, vh, offsetTop, offsetLeft);

    // 2. Canvasステージの利用可能な縦横サイズを自動計測
    const stage = getCanvasStageElement();
    let availW = vw - (UI.CANVAS_MARGIN_X || 6) * 2;
    let availH = vh - (UI.SAFE_TOP_HEADER_PX || 52) - 40;

    if (stage) {
        const style = window.getComputedStyle(stage);
        const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        const stageW = stage.clientWidth - padX;
        const stageH = stage.clientHeight - padY;
        if (stageW > 0 && stageH > 0) {
            availW = stageW;
            availH = stageH;
        }
    }

    // 3. 論理アスペクト比を維持して残りの縦横空間へ最大フィット
    const scaleX = availW / GAME_WIDTH;
    const scaleY = availH / GAME_HEIGHT;
    const scale = Math.max(0.1, Math.min(scaleX, scaleY));

    const cssWidth = Math.floor(GAME_WIDTH * scale);
    const cssHeight = Math.floor(GAME_HEIGHT * scale);

    // 4. Retina（DPR）高精細解像度を設定（負荷対策のため UI.MAX_DPR 上限適用）
    const dpr = Math.min(window.devicePixelRatio || 1, UI.MAX_DPR || 2);
    const pixelWidth = Math.round(GAME_WIDTH * dpr);
    const pixelHeight = Math.round(GAME_HEIGHT * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
    }
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    // 5. マウス/タッチ座標変換用のX/Y独立スケールを更新
    updateScale();
}

function bootGame() {
    if (isBooted) return;
    isBooted = true;

    // 1. 先にUIを初期化し、動的にコンテナ・上部中央スコア・Canvas等を生成・マウントさせる
    initUI(startGame);

    // 2. 生成された Canvas 要素を取得する
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');

    // 3. 画面サイズ変動（リサイズ・画面回転・スマホURLバー増減・GRAVITY WebView調整）を自動監視
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', handleResize);
        window.visualViewport.addEventListener('scroll', handleResize);
    }

    handleResize();
    // WebView初回描画直後のレイアウト確定にも対応するため次フレームでも再同期
    requestAnimationFrame(handleResize);

    // 4. 各モジュールの初期化とコールバック登録
    initInput(canvas, handleDragStart, handleDragUpdate, handleDragEnd);

    // 5. ゲーム開始
    startGame();
    requestAnimationFrame(gameLoop);
}

// GRAVITYローダー経由の動的インポートでも確実に起動するよう readyState で判定
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    bootGame();
} else {
    window.addEventListener('DOMContentLoaded', bootGame);
}