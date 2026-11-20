/**
 * main.js
 * @version v8.0 (Start Waiting Flow & GRAVITY postMessage Score Reporting - Phase 6)
 * @changes
 *   - dom_ui.js からのインポートへ showStartUI / hideStartUI を追加
 *   - GRAVITY ランキング向けスコア送信の正式仕様に準拠した export function reportScoreToGravity(finalScore) を実装（window.parent.postMessage({ type: 'gameOver', score: safeScore }, '*')・Number.isFinite 防御・window.parent !== window 判定・try-catch 保護・旧 AgentSDK 一切不使用）
 *   - gameState へ isWaitingStart および hasReportedScore を追加し、初回起動時のみ開始説明オーバーレイを表示して待機（待機中は背景ゼリーのアイドル物理のみ実行し maintainFloatBar / updateBumpers / 入力操作を停止して勝手スポーン・0点崩壊を防止、リトライ時は即開始）
 *   - ゲームオーバー確定直後に !gameState.hasReportedScore ガードのもとで reportScoreToGravity(finalScoreSnapshot) を厳密に 1 回だけ即時送信するよう実装
 * 
 * sobosuba風パズル（中空ビーズリング・ソフトボディ版）のマスター統合モジュール
 * 
 * GRAVITY規格に準拠するため、全てのモジュールを絶対パスでインポートし、
 * Matter.jsの固定タイムステップ・サブステップ物理シミュレーション、上部フロートバー管理、
 * 順方向ダイレクトエイム／2.5D上段飛び越えホップ、音量制御、開始待機フロー、
 * GRAVITYスコア送信、および描画ループを統合・管理します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, UI } from '/sobosuba/constants.js?v=7';
import { initPhysics, stepPhysics, updateBumpers, leftBumper, rightBumper } from '/sobosuba/physics.js?v=7';
import { updateSoftBodies } from '/sobosuba/softbody.js?v=7';
import { handleCollisions, handleMerges, resetMergeQueues } from '/sobosuba/jelly.js?v=7';
import { initFloatBar, maintainFloatBar } from '/sobosuba/floatbar.js?v=7';
import { resetAimState, syncAimToPointer, startAimDrag, updateAimDrag, endAimDrag } from '/sobosuba/aim.js?v=7';
import { renderGame } from '/sobosuba/render.js?v=7';
import { initUI, updateSoundUI, applyViewportSize, getCanvasStageElement, updateScoreUI, showStartUI, hideStartUI, showGameOverUI, hideGameOverUI, setWarningEffect } from '/sobosuba/dom_ui.js?v=7';
import { initInput, getPointerState, updateScale } from '/sobosuba/input.js?v=7';
import { isSoundEnabled, toggleSound, playSoundGameOverZap } from '/sobosuba/sound.js?v=7';

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
    isWaitingStart: false,
    isGameOver: false,
    hasReportedScore: false,
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
// GRAVITY ランキング向けスコア送信（標準 postMessage 方式・旧 AgentSDK 不使用）
// ==========================================
/**
 * ゲームオーバー確定時の最終スコアを GRAVITY 親ウィンドウへ postMessage で送信する
 * @param {number} finalScore - 確定した最終スコア（数値）
 */
export function reportScoreToGravity(finalScore) {
    try {
        const numericScore = Number(finalScore);
        const safeScore = Number.isFinite(numericScore) ? numericScore : 0;

        // GRAVITY 親ウィンドウ（iframe 内実行）が存在するか確認して postMessage 送信
        if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: 'gameOver',
                score: safeScore
            }, '*');
            console.log('[GRAVITY] スコア送信完了 (postMessage):', safeScore);
        } else {
            // PCブラウザや単体テスト時（iframe 外で直接実行されている場合）は安全にスキップ
            console.info('[Local Test] GRAVITY親ウィンドウが検出されませんでした。スコア送信をスキップします。 Final Score:', safeScore);
        }
    } catch (error) {
        console.warn('[GRAVITY Error] スコア送信中に例外が発生しました:', error);
    }
}

// ==========================================
// 音量トグル制御（ON時に同期ハード初期化を実行しUIを即同期）
// ==========================================
function handleToggleSound() {
    const enabled = toggleSound();
    updateSoundUI(enabled);
    return enabled;
}

// ==========================================
// 開始説明オーバーレイからのプレイ開始ハンドラ
// ==========================================
function handleStartFromOverlay() {
    if (!gameState.isWaitingStart) return;
    gameState.isWaitingStart = false;
    gameState.lastFloatSpawnTime = Date.now();
    hideStartUI();
}

// ==========================================
// ゲーム初期化・リセット処理
// ==========================================
/**
 * ゲームの初期化・リセットを行う
 * @param {boolean} [waitForStart=false] - 初回起動時に開始説明カードを表示して待機するかどうか（リトライ時は false）
 */
function startGame(waitForStart = false) {
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
    gameState.isWaitingStart = Boolean(waitForStart);
    gameState.isGameOver = false;
    gameState.hasReportedScore = false;
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
    if (gameState.isWaitingStart) {
        showStartUI();
    } else {
        hideStartUI();
    }
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
// 入力イベント橋渡し（開始待機2重ガード ＋ aim.js へ委譲 ＆ 発射クールダウン管理）
// ==========================================
function handleDragStart(startX, startY) {
    if (gameState.isWaitingStart) return;
    startAimDrag(world, gameState, startX, startY);
}

function handleDragUpdate(currentX, currentY) {
    if (gameState.isWaitingStart) return;
    updateAimDrag(engine, gameState, currentX, currentY);
}

function handleDragEnd() {
    if (gameState.isWaitingStart) return;
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
// メインゲームループ (毎フレーム実行・60Hz基準固定タイムステップ物理駆動)
// ==========================================
function gameLoop(timestamp) {
    requestAnimationFrame(gameLoop);

    if (!engine) return;

    const nowTs = typeof timestamp === 'number' ? timestamp : performance.now();
    const deltaMs = lastFrameTime > 0 ? (nowTs - lastFrameTime) : (1000 / 60);
    lastFrameTime = nowTs;

    gameState.frameCount++;

    if (!gameState.isGameOver) {
        // 1. 60Hz基準固定タイムステップ・4分割サブステップで物理演算およびソフトボディを更新
        // （初回開始待機中も背景の初期4個がぷるぷる浮くアイドル動作のみ維持）
        stepPhysics(deltaMs, (subDelta) => {
            updateSoftBodies(world, engine, subDelta);
        });

        // 開始画面待機中は勝手なスポーン・勝手合体（0点崩壊）・誤ゲームオーバーを防止するためゲーム進行監視を停止
        if (!gameState.isWaitingStart) {
            // 2. ドラッグ中に選択Soboがバー上で横移動した場合も、毎フレーム指先方向へ矢印・軌道予測を追従
            if (gameState.isDragging) {
                const ptr = getPointerState();
                if (ptr && ptr.isDragging) {
                    syncAimToPointer(engine, gameState, ptr.currentX, ptr.currentY);
                }
            }

            // 3. 上部フロートバーの左右2点スポーナー＆セーフティスポーンを監視・補充し上枠黒ゲージ進捗を更新
            maintainFloatBar(world, gameState);

            // 4. 左右バンパーの押し込み変位量・押し込み率および同時継続押し込み判定（stepPhysics の固定刻み実経過時間と同期）
            const bumperResult = updateBumpers();
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

                // GRAVITYランキング向けスコア送信（ゲームオーバー確定瞬間に1プレイ1回限定で即時送信）
                if (!gameState.hasReportedScore) {
                    gameState.hasReportedScore = true;
                    reportScoreToGravity(finalScoreSnapshot);
                }

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

    // 1. 先にUIを初期化し、動的にコンテナ・上部中央スコア・音量ON/OFFボタン・開始説明カード・Canvas等を生成・マウントさせる
    initUI(() => startGame(false), handleToggleSound, handleStartFromOverlay);
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

    // 5. 初回起動時は開始説明カードを表示して待機状態で開始（リトライ時は即開始）
    startGame(true);
    requestAnimationFrame(gameLoop);
}

// GRAVITYローダー経由の動的インポートでも確実に起動するよう readyState で判定
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    bootGame();
} else {
    window.addEventListener('DOMContentLoaded', bootGame);
}