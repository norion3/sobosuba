/**
 * main.js
 * @version v3.0 (Overhaul Step 9 - Final Integration)
 * @changes
 *   - window.visualViewport と DPR（UI.MAX_DPR）を自動取得し、GRAVITYの上下ネイティブUI帯を回避してCanvasの縦横サイズと解像度を自動調整するレスポンシブ制御を統合
 *   - 上部フロートバーの補充を、本家準拠の「左右2点クリアランス検知スポーナー」および両端閉塞時の「セーフティスポーン」へ刷新
 *   - タップでの「そっと落とし」と「外へドラッグしてから中心へ戻すキャンセル」を両立し、水平〜下方向の自在なエイム（横撃ち合体対応）と、ドラッグ中のSobo横移動に指先追従する矢印更新を実装
 *   - 本家完全準拠スコア（jelly.js から返る未合体初参加分のみを加算）へ移行し、合体保護期間明けの取りこぼしを防ぐ collisionActive 判定を追加
 *   - Matter.Runner を廃止して 4分割サブステップ物理ループ（stepPhysics）へ統合し、バンパー継続押し込み確定時のゲームオーバーザップ音（playSoundGameOverZap）を連携
 *   - GRAVITYキャッシュ不整合対策として、全モジュールの絶対パスインポートを ?v=3 へ統一
 * 
 * sobosuba風パズル（中空ビーズリング・ソフトボディ版）のマスター統合モジュール
 * 
 * GRAVITY規格に準拠するため、全てのモジュールを絶対パスでインポートし、
 * Matter.jsのサブステップ物理シミュレーション、上部フロートバー管理、
 * 順方向ダイレクトエイム、および描画ループを統合・管理します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, UI, JELLY_CONFIG, PHYSICS, FLOAT_BAR } from '/sobosuba/constants.js?v=3';
import { initPhysics, stepPhysics, updateBumpers, leftBumper, rightBumper } from '/sobosuba/physics.js?v=3';
import { createSoftBodyJelly, getSoftBodyCentroid, launchFloatingJelly, updateSoftBodies } from '/sobosuba/softbody.js?v=3';
import { handleCollisions, handleMerges, resetMergeQueues } from '/sobosuba/jelly.js?v=3';
import { initUI, applyViewportSize, getCanvasStageElement, updateScoreUI, showGameOverUI, hideGameOverUI, setWarningEffect } from '/sobosuba/dom_ui.js?v=3';
import { initInput, getPointerState, updateScale } from '/sobosuba/input.js?v=3';
import { renderGame } from '/sobosuba/render.js?v=3';
import { initSound, playSoundShoot, playSoundGameOverZap } from '/sobosuba/sound.js?v=3';

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

    // 順方向ダイレクトエイム用状態（そっと落とし／中心戻しキャンセル両立）
    isDragging: false,
    hasDraggedOut: false,
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
    // クールダウンタイマーが残っていれば解除
    if (dropCooldownTimer) {
        clearTimeout(dropCooldownTimer);
        dropCooldownTimer = null;
    }

    // リトライ時のゴーストゼリー発生を防ぐため、前ゲームの合体キューを完全初期化
    resetMergeQueues();

    // 物理エンジンの初期化（超低摩擦の壁・天井・底面角カット・上部左右バンパーの生成）
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

    // 上部フロートバーへ初期ゼリーを生成
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
// 上部フロートバー（左右2点クリアランス検知スポーナー ＆ セーフティスポーン）
// ==========================================
function generateNextValue() {
    const rand = Math.random();
    // スコア進行に応じて大きい数字が段階的に混ざる出現テーブル
    if (gameState.score > 2000 && rand > 0.95) return 16;
    if (gameState.score > 1000 && rand > 0.85) return 8;
    if (gameState.score > 300 && rand > 0.7) return 4;
    if (rand > 0.4) return 2;
    return 1;
}

/**
 * 現在上部フロートバー上に浮いている全ゼリーを取得する（中空ビーズリング対応）
 */
function getFloatingJellies() {
    if (!world) return [];
    const composites = Matter.Composite.allComposites(world);
    const list = [];
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp.label === 'jelly_composite' &&
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
 * スポーナーのクリアランス検知および重なり爆発防止のため、バー領域に存在する全ゼリーを取得する
 */
function getBarAreaJellies(newRadius) {
    if (!world) return [];
    const composites = Matter.Composite.allComposites(world);
    const list = [];
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp.label === 'jelly_composite' && comp.particles && comp.particles.length > 0) {
            const centroid = getSoftBodyCentroid(comp);
            if (!centroid) continue;
            const otherR = comp.targetRadius || 18;
            const dy = Math.abs(centroid.y - FLOAT_BAR.Y);
            if (comp.isFloating || dy < (otherR + newRadius + 14)) {
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
 */
function initFloatBar() {
    const count = Math.min(4, FLOAT_BAR.MAX_COUNT || 5);
    const values = [];
    const radii = [];
    let sumDiameters = 0;

    for (let i = 0; i < count; i++) {
        const val = generateNextValue();
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

    // バーが空になってからの経過時間を追跡（セーフティスポーン判定用）
    if (floating.length === 0) {
        if (gameState.barEmptySince === 0) {
            gameState.barEmptySince = now;
        }
    } else {
        gameState.barEmptySince = 0;
    }

    if (floating.length >= FLOAT_BAR.MAX_COUNT) return;
    if (now - gameState.lastFloatSpawnTime < FLOAT_BAR.SPAWN_DELAY_MS) return;

    // 次に補充する数値が未決定なら抽選して保持（空き待ち中の値ブレを防止）
    if (gameState.pendingSpawnValue === null) {
        gameState.pendingSpawnValue = generateNextValue();
    }

    const val = gameState.pendingSpawnValue;
    const config = JELLY_CONFIG[val] || JELLY_CONFIG[1];
    const r = config.radius;
    const clearanceMargin = FLOAT_BAR.SPAWN_CLEARANCE_MARGIN || 6;
    const entrySpeed = FLOAT_BAR.SPAWN_ENTRY_VELOCITY || 1.8;
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
    if (floating.length === 0 && gameState.barEmptySince > 0 && (now - gameState.barEmptySince) >= safetyDelay) {
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
// 順方向ダイレクトエイム（そっと落とし・中心戻しキャンセル・水平〜下方向自在発射）
// ==========================================
/**
 * ドラッグベクトルを最大距離でクランプし、極端な真上方向（天井逆流）のみを制限する
 * 水平〜わずかな上向きの横撃ち（バー上横当て合体）は自在に許可する
 */
function clampAimVector(dx, dy) {
    let vecX = dx;
    let vecY = dy;
    const rawDist = Math.sqrt(vecX * vecX + vecY * vecY);
    const maxDrag = PHYSICS.AIM_MAX_DRAG || 150;
    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 18;
    const minUpwardRatio = (PHYSICS.AIM_MIN_UPWARD_RATIO !== undefined) ? PHYSICS.AIM_MIN_UPWARD_RATIO : -0.22;

    if (rawDist > maxDrag) {
        const ratio = maxDrag / rawDist;
        vecX *= ratio;
        vecY *= ratio;
    }

    const clampedDist = Math.sqrt(vecX * vecX + vecY * vecY);
    if (clampedDist >= cancelRadius) {
        // 水平〜わずかな上向き（AIM_MIN_UPWARD_RATIO）まで許可し、極端な真上への天井突進のみ制限
        const minY = clampedDist * minUpwardRatio;
        if (vecY < minY) {
            const signX = vecX >= 0 ? 1 : -1;
            vecY = minY;
            vecX = signX * Math.sqrt(Math.max(0, clampedDist * clampedDist - vecY * vecY));
        }
    }

    return { x: vecX, y: vecY };
}

/**
 * 選択中のSoboの現在重心と最新ポインタ座標から、エイム矢印ベクトルを更新する
 * （本家v1.2準拠：バー上でSoboが横移動しても初期オフセットを維持して指先方向へ追従）
 */
function syncAimToPointer(pointerX, pointerY) {
    const selected = gameState.selectedJelly;
    if (!selected || selected.isMerging || !selected.isFloating) {
        gameState.isDragging = false;
        gameState.hasDraggedOut = false;
        gameState.selectedJelly = null;
        gameState.selectedJellyId = null;
        return;
    }

    const centroid = getSoftBodyCentroid(selected);
    if (!centroid) {
        gameState.isDragging = false;
        gameState.hasDraggedOut = false;
        gameState.selectedJelly = null;
        gameState.selectedJellyId = null;
        return;
    }

    const rawDx = pointerX - (centroid.x + gameState.dragOffsetX);
    const rawDy = pointerY - (centroid.y + gameState.dragOffsetY);
    const clamped = clampAimVector(rawDx, rawDy);
    const dist = Math.sqrt(clamped.x * clamped.x + clamped.y * clamped.y);
    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 18;

    // 一度でもキャンセル半径外へ伸ばしたかを記録（「そっと落とし」と「中心戻しキャンセル」の判別用）
    if (dist >= cancelRadius) {
        gameState.hasDraggedOut = true;
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

    // 上部フロートバー上のゼリーから、タップ位置に最も近いものを選択
    const floating = getFloatingJellies();
    if (floating.length === 0) return;

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
        if (dist < closestDist) {
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
    gameState.selectedJelly = null;
    gameState.selectedJellyId = null;
    gameState.hasDraggedOut = false;

    // 選択ゼリーが既に合体等で消えている場合は何もしない
    if (!selected || selected.isMerging || !selected.isFloating) {
        return;
    }

    const dist = Math.sqrt(gameState.dragVectorX ** 2 + gameState.dragVectorY ** 2);
    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 18;

    // 【操作判別】
    // 1. 一度外へ矢印を伸ばしてから中心へ戻して離した場合 → 発射キャンセル（消費しない）
    if (hasDraggedOut && dist < cancelRadius) {
        return;
    }

    // 2. タップして外へ伸ばさず離した場合 → 「そっと落とし」（加算初速 0、バー横速度のみ継承）
    // 3. 外へ伸ばして離した場合 → 「順方向ダイレクトエイム加算速度発射」
    let addVelocity = { x: 0, y: 0 };
    if (dist >= cancelRadius) {
        const safeAim = clampAimVector(gameState.dragVectorX, gameState.dragVectorY);
        addVelocity = {
            x: safeAim.x * PHYSICS.AIM_FORCE_MULTIPLIER,
            y: safeAim.y * PHYSICS.AIM_FORCE_MULTIPLIER
        };
    }

    // 発射音の再生
    playSoundShoot();

    // 選択していたバー上のゼリーを無重力から解放して発射（現在の移動速度へ加算）
    launchFloatingJelly(selected, addVelocity);
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
        // 1. 4分割サブステップで物理演算および中空ビーズリングPBD面積保存を更新
        stepPhysics(deltaMs, () => {
            updateSoftBodies(world, engine);
        });

        // 2. ドラッグ中に選択Soboがバー上で横移動した場合も、毎フレーム指先方向へ矢印を追従させる
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
            gameState.selectedJelly = null;
            gameState.selectedJellyId = null;

            // 本家準拠のゲームオーバーザップ音を再生
            playSoundGameOverZap();

            setWarningEffect(false);
            showGameOverUI(gameState.score);
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