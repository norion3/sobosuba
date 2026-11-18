/**
 * main.js
 * @version v2.0 (Bugfix Step 7)
 * @changes
 *   - バー上での事前合体を促すため、initFloatBar() を中央寄り配置へ変更し、maintainFloatBar() を既存ゼリーの隣へ合流補充するロジックへ修正
 *   - 上方向への極端な逆流発射を防ぐ角度制限（最小下向きクランプ）を追加し、バー領域残留ゼリーとの重なり爆発を防ぐ安全距離判定を追加
 *   - リトライ時のゴーストゼリー発生を防ぐため、startGame() 内で jelly.js の resetMergeQueues() を呼び出す処理を追加
 *   - GRAVITYキャッシュ不整合対策として、修正済み全モジュール（constants / physics / softbody / jelly / dom_ui / render）の絶対パスに ?v=2 を付与
 * 
 * sobosuba風パズル（ソフトボディ版）のマスター統合モジュール
 * 
 * GRAVITY規格に準拠するため、全てのモジュールを絶対パスでインポートし、
 * Matter.jsの物理シミュレーション、上部フロートバー管理、順方向ダイレクトエイム、
 * および描画ループを統合・管理します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, UI, JELLY_CONFIG, PHYSICS, SCORE, FLOAT_BAR } from '/sobosuba/constants.js?v=2';
import { initPhysics, updateBumpers, leftBumper, rightBumper } from '/sobosuba/physics.js?v=2';
import { createSoftBodyJelly, launchFloatingJelly, updateSoftBodies } from '/sobosuba/softbody.js?v=2';
import { handleCollisions, handleMerges, resetMergeQueues } from '/sobosuba/jelly.js?v=2';
import { initUI, updateScoreUI, showGameOverUI, hideGameOverUI, setWarningEffect } from '/sobosuba/dom_ui.js?v=2';
import { initInput, updateScale } from '/sobosuba/input.js';
import { renderGame } from '/sobosuba/render.js?v=2';
import { initSound, playSoundShoot } from '/sobosuba/sound.js';

// ==========================================
// グローバル変数・ゲームステート
// ==========================================
let engine;
let world;
let runner;
let canvas;
let ctx;
let isBooted = false;

const gameState = {
    score: 0,
    isGameOver: false,
    canDrop: true,
    frameCount: 0,

    // 上部フロートバーの選択中ゼリー管理
    selectedJelly: null,
    selectedJellyId: null,
    lastFloatSpawnTime: 0,

    // 順方向ダイレクトエイム用状態
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragCurrentX: 0,
    dragCurrentY: 0,
    dragVectorX: 0,
    dragVectorY: 0,

    // 連鎖(コンボ)ボーナス用状態
    lastMergeTime: 0,
    comboCount: 0
};

// ==========================================
// ゲーム初期化・リセット処理
// ==========================================
function startGame() {
    // リトライ時のゴーストゼリー発生を防ぐため、前ゲームの合体キューを完全初期化
    resetMergeQueues();

    // 物理エンジンの初期化（壁・天井・底面角カット・上部左右バンパーの生成）
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
    gameState.dragVectorX = 0;
    gameState.dragVectorY = 0;
    gameState.lastMergeTime = 0;
    gameState.comboCount = 0;
    gameState.lastFloatSpawnTime = Date.now();

    // UIのリセット
    updateScoreUI(gameState.score);
    hideGameOverUI();
    setWarningEffect(false);

    // 上部フロートバーへ初期ゼリーを中央寄りに横並びで生成
    initFloatBar();

    // ==========================================
    // Matter.js イベントのバインド
    // ==========================================
    Matter.Events.on(engine, 'beforeUpdate', () => {
        // 毎物理ステップで内部圧力（面積保存）・裏返り防止・バー上無重力浮遊を更新
        updateSoftBodies(world, engine);
    });

    Matter.Events.on(engine, 'collisionStart', (event) => {
        // 同一数字のソフトボディ同士が衝突したか判定し、基本スコアを獲得
        const earned = handleCollisions(event);
        if (earned > 0) {
            const now = Date.now();
            // 1秒(1000ms)以内の連続合体を連鎖(コンボ)として判定
            if (now - gameState.lastMergeTime < 1000) {
                gameState.comboCount++;
            } else {
                gameState.comboCount = 0;
            }
            gameState.lastMergeTime = now;

            // 連鎖数に応じて倍率を適用
            const multiplier = Math.pow(SCORE.COMBO_MULTIPLIER, gameState.comboCount);
            gameState.score += Math.floor(earned * multiplier);

            updateScoreUI(gameState.score);
        }
    });

    Matter.Events.on(engine, 'afterUpdate', () => {
        // 物理演算後に、合体キューに入ったソフトボディの破棄と再構築を安全に行う
        handleMerges(world);
    });

    // 物理シミュレーションの起動
    if (runner) {
        Matter.Runner.stop(runner);
    }
    runner = Matter.Runner.create();
    Matter.Runner.run(runner, engine);
}

// ==========================================
// 上部フロートバー（物理待機列）管理ロジック
// ==========================================
function generateNextValue() {
    const rand = Math.random();
    // スコアに応じて大きい数字が出やすくなる確率調整
    if (gameState.score > 2000 && rand > 0.95) return 16;
    if (gameState.score > 1000 && rand > 0.85) return 8;
    if (gameState.score > 300 && rand > 0.7) return 4;
    if (rand > 0.4) return 2;
    return 1;
}

/**
 * 現在上部フロートバー上に浮いている全ゼリーを取得する
 */
function getFloatingJellies() {
    if (!world) return [];
    const composites = Matter.Composite.allComposites(world);
    const list = [];
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp.label === 'jelly_composite' && comp.isFloating && !comp.isMerging && comp.core) {
            list.push(comp);
        }
    }
    return list;
}

/**
 * 補充時の重なり爆発を防ぐため、バー領域に存在する全ゼリー（浮遊中＋発射直後の残留）を取得する
 */
function getBarAreaJellies(newRadius) {
    if (!world) return [];
    const composites = Matter.Composite.allComposites(world);
    const list = [];
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp.label === 'jelly_composite' && comp.core) {
            const otherR = comp.targetRadius || 18;
            const dy = Math.abs(comp.core.position.y - FLOAT_BAR.Y);
            if (comp.isFloating || dy < (otherR + newRadius + 14)) {
                list.push(comp);
            }
        }
    }
    return list;
}

/**
 * 指定座標 (x, FLOAT_BAR.Y) に半径 r のゼリーを安全（重なりなし）に配置できるか判定する
 */
function isSafeBarSpawnPosition(candidateX, r, barAreaJellies) {
    const minX = FLOAT_BAR.PADDING_X + r;
    const maxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - r;
    if (candidateX < minX || candidateX > maxX) return false;

    for (let i = 0; i < barAreaJellies.length; i++) {
        const other = barAreaJellies[i];
        const otherR = other.targetRadius || 18;
        const dx = candidateX - other.core.position.x;
        const dy = FLOAT_BAR.Y - other.core.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // 重なり爆発を防ぐため、半径の合計＋安全マージン以上の距離を確保
        if (dist < (r + otherR + 3)) {
            return false;
        }
    }
    return true;
}

/**
 * ゲーム開始時に上部フロートバーへ初期ゼリーを中央寄りの適度な間隔で配置する
 */
function initFloatBar() {
    const count = FLOAT_BAR.MAX_COUNT;
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

    const gap = 4;
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

        const comp = createSoftBodyJelly(clampedX, FLOAT_BAR.Y, values[i], null, true);
        Matter.Composite.add(world, comp);

        cursorX += (r * 2 + gap) * scaleRatio;
    }
}

/**
 * バー上の空きスペースに、既存ゼリーと重ならず隣へ合流するように新しい浮遊ゼリーを補充する
 */
function maintainFloatBar() {
    if (gameState.isGameOver || !world) return;

    const floating = getFloatingJellies();
    if (floating.length >= FLOAT_BAR.MAX_COUNT) return;

    const now = Date.now();
    if (now - gameState.lastFloatSpawnTime < FLOAT_BAR.SPAWN_DELAY_MS) return;

    const val = generateNextValue();
    const config = JELLY_CONFIG[val] || JELLY_CONFIG[1];
    const r = config.radius;
    const minX = FLOAT_BAR.PADDING_X + r;
    const maxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - r;
    const barAreaJellies = getBarAreaJellies(r);

    // 候補座標リストを作成（既存ゼリー群の左右すぐ隣から中央へスライド合流する位置を最優先）
    const candidates = [];

    if (floating.length === 0) {
        candidates.push(GAME_WIDTH / 2, minX, maxX);
    } else {
        let leftMostEdge = Infinity;
        let rightMostEdge = -Infinity;

        for (let i = 0; i < floating.length; i++) {
            const other = floating[i];
            const otherR = other.targetRadius || 18;
            const leftEdge = other.core.position.x - otherR;
            const rightEdge = other.core.position.x + otherR;
            if (leftEdge < leftMostEdge) leftMostEdge = leftEdge;
            if (rightEdge > rightMostEdge) rightMostEdge = rightEdge;
        }

        const leftAdj = leftMostEdge - r - 4;
        const rightAdj = rightMostEdge + r + 4;

        // 中央に近い側の隣を先に試すことでバランス良く左右から合流させる
        if (Math.abs(leftAdj - GAME_WIDTH / 2) <= Math.abs(rightAdj - GAME_WIDTH / 2)) {
            candidates.push(leftAdj, rightAdj);
        } else {
            candidates.push(rightAdj, leftAdj);
        }

        // 左右端からの合流位置および中間スロットをフォールバック候補として追加
        candidates.push(minX, maxX);
        const samples = 9;
        for (let s = 0; s < samples; s++) {
            candidates.push(minX + ((maxX - minX) * s) / (samples - 1));
        }
    }

    // 候補の中から、バー付近のすべてのゼリー（発射直後の残留含む）と重ならない最初の安全位置を採用
    let spawnX = null;
    for (let i = 0; i < candidates.length; i++) {
        const candX = candidates[i];
        if (isSafeBarSpawnPosition(candX, r, barAreaJellies)) {
            spawnX = candX;
            break;
        }
    }

    // 発射直後のゼリーがまだバー上に留まっている等で安全距離が取れない場合は次フレームへ見送る
    if (spawnX === null) return;

    const newComp = createSoftBodyJelly(spawnX, FLOAT_BAR.Y, val, null, true);
    Matter.Composite.add(world, newComp);
    gameState.lastFloatSpawnTime = now;
}

// ==========================================
// 順方向ダイレクトエイム（選択＆発射）入力ハンドリング
// ==========================================
/**
 * ドラッグベクトルを最大距離でクランプし、上方向への極端な逆流発射を防ぐため下向き方向へ角度制限する
 */
function clampAimVector(dx, dy) {
    let vecX = dx;
    let vecY = dy;
    const rawDist = Math.sqrt(vecX * vecX + vecY * vecY);
    const maxDrag = PHYSICS.AIM_MAX_DRAG || 150;
    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 18;

    if (rawDist > maxDrag) {
        const ratio = maxDrag / rawDist;
        vecX *= ratio;
        vecY *= ratio;
    }

    const clampedDist = Math.sqrt(vecX * vecX + vecY * vecY);
    if (clampedDist >= cancelRadius) {
        // 最小下向き成分を保証し、天井方向への逆流やバー横突進を防止
        const minDownY = clampedDist * 0.18;
        if (vecY < minDownY) {
            const signX = vecX >= 0 ? 1 : -1;
            vecY = minDownY;
            vecX = signX * Math.sqrt(Math.max(0, clampedDist * clampedDist - vecY * vecY));
        }
    }

    return { x: vecX, y: vecY };
}

function handleDragStart(startX, startY) {
    if (gameState.isGameOver || !gameState.canDrop) return;

    // サウンド機能の初期化（ブラウザ制約により初回ユーザー操作時にアクティブ化）
    initSound();

    // 上部フロートバー上のゼリーから、タップ位置に最も近いものを選択
    const floating = getFloatingJellies();
    if (floating.length === 0) return;

    let closest = null;
    let closestDist = Infinity;

    for (let i = 0; i < floating.length; i++) {
        const comp = floating[i];
        const dx = startX - comp.core.position.x;
        const dy = startY - comp.core.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestDist) {
            closestDist = dist;
            closest = comp;
        }
    }

    if (!closest) return;

    gameState.selectedJelly = closest;
    gameState.selectedJellyId = closest.jellyId;
    gameState.isDragging = true;
    gameState.dragStartX = closest.core.position.x;
    gameState.dragStartY = closest.core.position.y;
    gameState.dragCurrentX = gameState.dragStartX;
    gameState.dragCurrentY = gameState.dragStartY;
    gameState.dragVectorX = 0;
    gameState.dragVectorY = 0;
}

function handleDragUpdate(currentX, currentY, dx, dy) {
    if (!gameState.isDragging) return;

    // ドラッグ中に選択ゼリーがバー上合体等で消滅していないか検証
    const selected = gameState.selectedJelly;
    if (!selected || selected.isMerging || !selected.isFloating || !selected.core) {
        gameState.isDragging = false;
        gameState.selectedJelly = null;
        gameState.selectedJellyId = null;
        return;
    }

    // 最大ドラッグ距離と下向き安全角度でクランプ
    const clamped = clampAimVector(dx, dy);

    gameState.dragStartX = selected.core.position.x;
    gameState.dragStartY = selected.core.position.y;
    gameState.dragCurrentX = gameState.dragStartX + clamped.x;
    gameState.dragCurrentY = gameState.dragStartY + clamped.y;
    gameState.dragVectorX = clamped.x;
    gameState.dragVectorY = clamped.y;
}

function handleDragEnd() {
    if (!gameState.isDragging) return;
    gameState.isDragging = false;

    const selected = gameState.selectedJelly;
    gameState.selectedJelly = null;
    gameState.selectedJellyId = null;

    // 選択ゼリーが既に合体等で消えている場合は何もしない
    if (!selected || selected.isMerging || !selected.isFloating || !selected.core) {
        return;
    }

    // 指を元の位置（キャンセル半径内）に戻した場合は発射キャンセル（消費しない）
    const dist = Math.sqrt(gameState.dragVectorX ** 2 + gameState.dragVectorY ** 2);
    const cancelRadius = PHYSICS.AIM_CANCEL_RADIUS || 18;
    if (dist < cancelRadius) {
        return;
    }

    // 発射音の再生
    playSoundShoot();

    // 順方向ダイレクトエイム：下向き安全制限を通した矢印の向きへそのまま発射
    const safeAim = clampAimVector(gameState.dragVectorX, gameState.dragVectorY);
    const initialVelocity = {
        x: safeAim.x * PHYSICS.AIM_FORCE_MULTIPLIER,
        y: safeAim.y * PHYSICS.AIM_FORCE_MULTIPLIER
    };

    // 選択していたバー上のゼリーを無重力から解放して発射
    launchFloatingJelly(selected, initialVelocity);
    gameState.lastFloatSpawnTime = Date.now();

    gameState.canDrop = false;
    setTimeout(() => {
        if (!gameState.isGameOver) gameState.canDrop = true;
    }, UI.DROP_COOLDOWN_MS);
}

// ==========================================
// メインゲームループ (毎フレーム実行)
// ==========================================
function gameLoop() {
    requestAnimationFrame(gameLoop);

    if (!engine) return;
    gameState.frameCount++;

    // 上部フロートバーのゼリー数を監視・補充
    maintainFloatBar();

    // 左右バンパーの押し込み変位量を判定
    const bumperResult = updateBumpers();

    // 【ゲームオーバー判定】両側のバンパーが同時に押し込まれた場合
    if (bumperResult.leftPressed && bumperResult.rightPressed && !gameState.isGameOver) {
        gameState.isGameOver = true;
        gameState.canDrop = false;
        gameState.isDragging = false;
        gameState.selectedJelly = null;
        gameState.selectedJellyId = null;

        // 物理シミュレーションを完全停止
        if (runner) Matter.Runner.stop(runner);

        setWarningEffect(false);
        showGameOverUI(gameState.score);
    } else {
        // 片側だけ押し込まれた場合は、UIレイヤーに警告エフェクト(赤点滅)を指示
        setWarningEffect(bumperResult.leftPressed || bumperResult.rightPressed);
    }

    // 描画モジュールへ渡すバンパー状態
    const renderBumperState = {
        leftBumper,
        rightBumper,
        leftPressed: bumperResult.leftPressed,
        rightPressed: bumperResult.rightPressed
    };

    // Canvasへのレンダリング
    renderGame(ctx, world, gameState, renderBumperState);
}

// ==========================================
// ウィンドウリサイズとGRAVITY対応即時起動シーケンス
// ==========================================
function handleResize() {
    if (!canvas) return;

    const w = window.innerWidth;
    const h = window.innerHeight;

    // 画面のアスペクト比を維持しつつ最大化
    const scaleX = w / GAME_WIDTH;
    const scaleY = h / GAME_HEIGHT;
    const scale = Math.min(scaleX, scaleY);

    canvas.width = GAME_WIDTH;
    canvas.height = GAME_HEIGHT;
    canvas.style.width = `${GAME_WIDTH * scale}px`;
    canvas.style.height = `${GAME_HEIGHT * scale}px`;

    // マウス/タッチ座標変換用のスケールを更新
    updateScale();
}

function bootGame() {
    if (isBooted) return;
    isBooted = true;

    // 1. 先にUIを初期化し、動的に Canvas 等のDOM要素を生成・マウントさせる
    initUI(startGame);

    // 2. 生成された Canvas 要素を取得する
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');

    window.addEventListener('resize', handleResize);
    handleResize();

    // 各モジュールの初期化とコールバック登録
    initInput(canvas, handleDragStart, handleDragUpdate, handleDragEnd);

    // ゲーム開始
    startGame();
    requestAnimationFrame(gameLoop);
}

// GRAVITYローダー経由の動的インポートでも確実に起動するよう readyState で判定
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    bootGame();
} else {
    window.addEventListener('DOMContentLoaded', bootGame);
}