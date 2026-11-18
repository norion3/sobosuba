/**
 * main.js
 * sobosuba風パズル（ソフトボディ版）のマスター統合モジュール
 * 
 * GRAVITY規格に準拠するため、全てのモジュールを絶対パスでインポートし、
 * Matter.jsの物理シミュレーションと描画ループを統合・管理します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, UI, JELLY_CONFIG, DROP_Y, PHYSICS } from '/sobosuba/constants.js';
import { initPhysics, updateBumpers, leftBumper, rightBumper } from '/sobosuba/physics.js';
import { createSoftBodyJelly } from '/sobosuba/softbody.js';
import { handleCollisions, handleMerges } from '/sobosuba/jelly.js';
import { initUI, updateScoreUI, updateNextPreviewUI, showGameOverUI, hideGameOverUI, setWarningEffect } from '/sobosuba/dom_ui.js';
import { initInput, updateScale } from '/sobosuba/input.js';
import { renderGame } from '/sobosuba/render.js';

// ==========================================
// グローバル変数・ゲームステート
// ==========================================
let engine;
let world;
let runner;
let canvas;
let ctx;

const gameState = {
    score: 0,
    isGameOver: false,
    canDrop: true,
    dropX: GAME_WIDTH / 2,
    nextValue: 1,
    nextQueue: [], // ★追加: 3〜4個の待機列を保持する配列
    frameCount: 0,
    
    // ★追加: スリングショット用状態
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragCurrentX: 0,
    dragCurrentY: 0,
    dragVectorX: 0,
    dragVectorY: 0
};

// ==========================================
// ゲーム初期化・リセット処理
// ==========================================
function startGame() {
    // 物理エンジンの初期化（壁・左右スリムバンパーの生成）
    const physics = initPhysics();
    engine = physics.engine;
    world = physics.world;

    // ステートのリセット
    gameState.score = 0;
    gameState.isGameOver = false;
    gameState.canDrop = true;
    gameState.frameCount = 0;
    gameState.nextQueue = [];
    
    // UIのリセット
    updateScoreUI(gameState.score);
    hideGameOverUI();
    setWarningEffect(false);
    
    // 待機列（キュー）の初期化
    fillQueue();
    updateNextPreviewUI(gameState.nextQueue);

    // ==========================================
    // Matter.js イベントのバインド
    // ==========================================
    Matter.Events.on(engine, 'collisionStart', (event) => {
        // 同一数字のソフトボディ同士が衝突したか判定し、スコアを加算
        const earned = handleCollisions(event);
        if (earned > 0) {
            gameState.score += earned;
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
// ゼリー待機列（キュー）管理ロジック
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

function fillQueue() {
    // 規定数(UI.QUEUE_SIZE)に達するまで待機列に補充
    while (gameState.nextQueue.length < UI.QUEUE_SIZE) {
        gameState.nextQueue.push(generateNextValue());
    }
    // 先頭の値を現在の発射対象としてセット
    gameState.nextValue = gameState.nextQueue[0];
}

function advanceQueue() {
    // 先頭を消費し、後ろに新しい数字を補充
    gameState.nextQueue.shift();
    fillQueue();
    updateNextPreviewUI(gameState.nextQueue);
}

// ==========================================
// スリングショット（引っ張り発射）入力ハンドリング
// ==========================================
function handleDragStart(startX, startY) {
    if (gameState.isGameOver || !gameState.canDrop) return;
    
    const config = JELLY_CONFIG[gameState.nextValue];
    const r = config ? config.radius : 18;
    
    // 左右の壁・バンパーにめり込まないように投下X座標を制限(クランプ)
    gameState.dropX = Math.max(r + 24, Math.min(GAME_WIDTH - r - 24, startX));
    
    gameState.isDragging = true;
    gameState.dragStartX = gameState.dropX;
    gameState.dragStartY = DROP_Y;
    gameState.dragCurrentX = gameState.dragStartX;
    gameState.dragCurrentY = gameState.dragStartY;
    gameState.dragVectorX = 0;
    gameState.dragVectorY = 0;
}

function handleDragUpdate(currentX, currentY, dx, dy) {
    if (!gameState.isDragging) return;
    
    gameState.dragCurrentX = gameState.dropX + dx;
    gameState.dragCurrentY = DROP_Y + dy;
    gameState.dragVectorX = dx;
    gameState.dragVectorY = dy;
}

function handleDragEnd() {
    if (!gameState.isDragging) return;
    gameState.isDragging = false;
    
    // 引っ張り量が少なすぎる場合はキャンセル扱い（ゼリーを消費しない）
    const dist = Math.sqrt(gameState.dragVectorX ** 2 + gameState.dragVectorY ** 2);
    if (dist < 10) {
        return;
    }

    // 引いた方向と「逆向き」に発射するベクトルの計算
    // Matter.jsのsetVelocity用に定数係数を調整
    const velocityScale = PHYSICS.SLINGSHOT_FORCE_MULTIPLIER * 1000;
    const initialVelocity = {
        x: -gameState.dragVectorX * velocityScale,
        y: -gameState.dragVectorY * velocityScale
    };
    
    // 新しいソフトボディ（ぐにゃぐにゃ剛体）を生成して投下
    const newComposite = createSoftBodyJelly(gameState.dropX, DROP_Y, gameState.nextValue, initialVelocity);
    Matter.Composite.add(world, newComposite);
    
    gameState.canDrop = false;
    advanceQueue();
    
    // 次の投下までのクールダウン
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

    // 左右バンパーの押し込み変位量を判定
    const bumperResult = updateBumpers();
    
    // 【ゲームオーバー判定】両側のバンパーが同時に押し込まれた場合
    if (bumperResult.leftPressed && bumperResult.rightPressed && !gameState.isGameOver) {
        gameState.isGameOver = true;
        gameState.canDrop = false;
        gameState.isDragging = false;
        
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

    // Canvasへのレンダリング（メタボール描画および照準矢印）
    renderGame(ctx, world, gameState, renderBumperState);
}

// ==========================================
// ウィンドウリサイズと起動シーケンス
// ==========================================
function handleResize() {
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

window.onload = () => {
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');
    
    window.addEventListener('resize', handleResize);
    handleResize();
    
    // 各モジュールの初期化とコールバック登録
    initUI(startGame);
    initInput(canvas, handleDragStart, handleDragUpdate, handleDragEnd);
    
    // ゲーム開始
    startGame();
    requestAnimationFrame(gameLoop);
};