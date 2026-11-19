/**
 * main.js
 * @version v6.0 (Fluid Physics, Controls, Bumper & Audio Overhaul Step 11 - Final Integration)
 * @changes
 *   - initUI(startGame, handleToggleSound) へ sound.js の同期ハード初期化付きトグル（toggleSound）を接続し、起動時デフォルト OFF の UI 状態（updateSoundUI）を同期（リトライ時も音量設定を維持）
 *   - stepPhysics() のコールバックから subDelta を受け取り updateSoftBodies(world, engine, subDelta) へ引き渡すことで遅延適応的圧迫ダンピングを正確に駆動し、endAimDrag(gameState, onLaunched, world) へ world を連携（斜め下すり抜け保護の同数字隣接判定用）
 *   - GRAVITYキャッシュ不整合対策として、v6.0全更新モジュール（constants / physics / softbody / jelly / floatbar / aim / render / dom_ui / sound）の絶対パスインポートを ?v=6 へ統一（無変更安定の input.js は ?v=4 を維持）
 * 
 * sobosuba風パズル（中空ビーズリング・ソフトボディ版）のマスター統合モジュール
 * 
 * GRAVITY規格に準拠するため、全てのモジュールを絶対パスでインポートし、
 * Matter.jsのサブステップ物理シミュレーション、上部フロートバー管理、
 * 順方向ダイレクトエイム／2.5D上段飛び越えホップ、音量制御、および描画ループを統合・管理します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, UI } from '/sobosuba/constants.js?v=6';
import { initPhysics, stepPhysics, updateBumpers, leftBumper, rightBumper } from '/sobosuba/physics.js?v=6';
import { updateSoftBodies } from '/sobosuba/softbody.js?v=6';
import { handleCollisions, handleMerges, resetMergeQueues } from '/sobosuba/jelly.js?v=6';
import { initFloatBar, maintainFloatBar } from '/sobosuba/floatbar.js?v=6';
import { resetAimState, syncAimToPointer, startAimDrag, updateAimDrag, endAimDrag } from '/sobosuba/aim.js?v=6';
import { renderGame } from '/sobosuba/render.js?v=6';
import { initUI, updateSoundUI, applyViewportSize, getCanvasStageElement, updateScoreUI, showGameOverUI, hideGameOverUI, setWarningEffect } from '/sobosuba/dom_ui.js?v=6';
import { initInput, getPointerState, updateScale } from '/sobosuba/input.js?v=4';
import { isSoundEnabled, toggleSound, playSoundGameOverZap } from '/sobosuba/sound.js?v=6';

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

const gameState = {
    score: 0,
    isGameOver: false,
    canDrop: true,
    frameCount: 0,

    // 上部フロートバーの選択中ゼリー・スポーナー・上枠黒ゲージ管理
    selectedJelly: null,
    selectedJellyId: null,
    lastFloatSpawnTime: 0,
    barEmptySince: 0,
    pendingSpawnValue: null,
    lastSpawnSide: 'right',
    spawnerGauges: {
        leftGaugeRatio: 0,
        rightGaugeRatio: 0
    },

    // 順方向ダイレクトエイム ＆ 2.5D上段飛び越えホップ状態
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

    // 描画用バンパー最新状態キャッシュ（左右枠内の赤点灯サイドバー連動用）
    lastBumperState: {
        leftPressed: false,
        rightPressed: false,
        leftPushRatio: 0,
        rightPushRatio: 0
    }
};

// ==========================================
// 音量トグル制御（ON時に同期ハード初期化を実行しUIを即同期）
// ==========================================
function handleToggleSound() {
    const enabled = toggleSound();
    updateSoundUI(enabled);
    return enabled;
}

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

    // 物理エンジンの初期化（極低摩擦の壁・天井クッション・底面角カット・上部左右バンパーの生成）
    const physics = initPhysics();
    engine = physics.engine;
    world = physics.world;

    // ステートのリセット（音量ON/OFF設定はリトライ時もそのまま維持）
    gameState.score = 0;
    gameState.isGameOver = false;
    gameState.canDrop = true;
    gameState.frameCount = 0;
    resetAimState(gameState);
    gameState.lastFloatSpawnTime = Date.now();
    gameState.barEmptySince = 0;
    gameState.pendingSpawnValue = null;
    gameState.lastSpawnSide = 'right';
    gameState.spawnerGauges.leftGaugeRatio = 0;
    gameState.spawnerGauges.rightGaugeRatio = 0;
    gameState.lastBumperState = {
        leftPressed: false,
        rightPressed: false,
        leftPushRatio: 0,
        rightPushRatio: 0
    };
    lastFrameTime = 0;

    // UIのリセット
    updateScoreUI(gameState.score);
    hideGameOverUI();
    setWarningEffect(false);

    // 上部フロートバーへ初期ゼリーを横長カプセル実幅間隔・隣接重複なしで生成
    initFloatBar(world, gameState);

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
// 入力イベント橋渡し（aim.js へ委譲 ＆ 発射クールダウン管理）
// ==========================================
function handleDragStart(startX, startY) {
    startAimDrag(world, gameState, startX, startY);
}

function handleDragUpdate(currentX, currentY) {
    updateAimDrag(engine, gameState, currentX, currentY);
}

function handleDragEnd() {
    endAimDrag(gameState, () => {
        gameState.canDrop = false;
        if (dropCooldownTimer) clearTimeout(dropCooldownTimer);
        dropCooldownTimer = setTimeout(() => {
            dropCooldownTimer = null;
            if (!gameState.isGameOver) gameState.canDrop = true;
        }, UI.DROP_COOLDOWN_MS);
    }, world);
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
        // 1. 4分割サブステップで物理演算およびソフトボディ（完全液体物理・遅延適応ダンピング・分散排斥）を更新
        stepPhysics(deltaMs, (subDelta) => {
            updateSoftBodies(world, engine, subDelta);
        });

        // 2. ドラッグ中に選択Soboがバー上で横移動した場合も、毎フレーム指先方向へ矢印・軌道予測を追従
        if (gameState.isDragging) {
            const ptr = getPointerState();
            if (ptr && ptr.isDragging) {
                syncAimToPointer(engine, gameState, ptr.currentX, ptr.currentY);
            }
        }

        // 3. 上部フロートバーの左右2点スポーナー＆セーフティスポーンを監視・補充し上枠黒ゲージ進捗を更新
        maintainFloatBar(world, gameState);

        // 4. 左右バンパーの押し込み変位量・押し込み率（枠内赤点灯サイドバー連動）および同時継続押し込み判定
        const bumperResult = updateBumpers(deltaMs);
        gameState.lastBumperState = {
            leftPressed: bumperResult.leftPressed,
            rightPressed: bumperResult.rightPressed,
            leftPushRatio: bumperResult.leftPushRatio,
            rightPushRatio: bumperResult.rightPushRatio
        };

        // 【ゲームオーバー判定】両側のバンパーが同時に連続250ms押し込まれた場合
        if (bumperResult.isGameOverTriggered) {
            gameState.isGameOver = true;
            gameState.canDrop = false;
            resetAimState(gameState);

            // 両側赤サイドバー全点灯を維持したままザップ音を即座に再生し、550msの静止余韻後にリザルト表示
            gameState.lastBumperState.leftPressed = true;
            gameState.lastBumperState.rightPressed = true;
            gameState.lastBumperState.leftPushRatio = 1;
            gameState.lastBumperState.rightPushRatio = 1;

            playSoundGameOverZap();
            setWarningEffect(true);

            const finalScoreSnapshot = gameState.score;
            const delayMs = UI.GAME_OVER_DELAY_MS || 550;
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

    // 描画モジュールへ渡すバンパー状態（枠内赤点灯サイドバー用の押し込み率を含む）
    const renderBumperState = {
        leftBumper,
        rightBumper,
        leftPressed: gameState.lastBumperState.leftPressed,
        rightPressed: gameState.lastBumperState.rightPressed,
        leftPushRatio: gameState.lastBumperState.leftPushRatio,
        rightPushRatio: gameState.lastBumperState.rightPushRatio
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

    // 1. 先にUIを初期化し、動的にコンテナ・上部中央スコア・音量ON/OFFボタン・Canvas等を生成・マウントさせる
    initUI(startGame, handleToggleSound);
    updateSoundUI(isSoundEnabled());

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