/**
 * main.js
 * sobosuba風パズルのマスター統合モジュール
 * 
 * GRAVITY規格に準拠するため、全てのモジュールを絶対パスでインポートし、
 * ゲームループ（requestAnimationFrame）と全体の状態遷移を管理します。
 */

import { GAME_WIDTH, GAME_HEIGHT, UI, JELLY_CONFIG, DROP_Y } from '/sobosuba/constants.js';
import { initPhysics, updateBumpers, leftBumper, rightBumper } from '/sobosuba/physics.js';
import { createJelly, handleCollisions, handleMerges } from '/sobosuba/jelly.js';
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
    frameCount: 0
};

// ==========================================
// ゲーム初期化・リセット処理
// ==========================================
function startGame() {
    // 物理エンジンの初期化（バンパー、壁の生成）
    const physics = initPhysics();
    engine = physics.engine;
    world = physics.world;

    // ステートのリセット
    gameState.score = 0;
    gameState.isGameOver = false;
    gameState.canDrop = true;
    gameState.frameCount = 0;
    
    // UIのリセット
    updateScoreUI(gameState.score);
    hideGameOverUI();
    setWarningEffect(false);
    pickNextValue();

    // ==========================================
    // Matter.js 衝突イベントのバインド
    // ==========================================
    Matter.Events.on(engine, 'collisionStart', (event) => {
        const earned = handleCollisions(event);
        if (earned > 0) {
            gameState.score += earned;
            updateScoreUI(gameState.score);
        }
    });

    Matter.Events.on(engine, 'afterUpdate', () => {
        handleMerges(world);
    });

    // 物理シミュレーションランナーの起動
    if (runner) {
        Matter.Runner.stop(runner);
    }
    runner = Matter.Runner.create();
    Matter.Runner.run(runner, engine);
}

// ==========================================
// ゼリー落下と次弾補充ロジック
// ==========================================
function pickNextValue() {
    const rand = Math.random();
    // 進行度（スコア）に応じて大きい数字が出やすくなる
    if (gameState.score > 2000 && rand > 0.95) gameState.nextValue = 16;
    else if (gameState.score > 1000 && rand > 0.85) gameState.nextValue = 8;
    else if (gameState.score > 300 && rand > 0.7) gameState.nextValue = 4;
    else if (rand > 0.4) gameState.nextValue = 2;
    else gameState.nextValue = 1;
    
    updateNextPreviewUI(gameState.nextValue);
}

function handlePointerMove(relativeX) {
    if (gameState.isGameOver || !gameState.canDrop) return;
    
    const config = JELLY_CONFIG[gameState.nextValue];
    const r = config ? config.radius : 18;
    // 左右のバンパー（幅24px）や壁にめり込まないよう座標をクランプする
    gameState.dropX = Math.max(r + 24, Math.min(GAME_WIDTH - r - 24, relativeX));
}

function handlePointerDrop() {
    if (gameState.isGameOver || !gameState.canDrop) return;
    
    // 新しいゼリーを物理空間に投下
    const newBody = createJelly(gameState.dropX, DROP_Y, gameState.nextValue, true);
    Matter.Composite.add(world, newBody);
    
    gameState.canDrop = false;
    pickNextValue();
    
    // クールダウン経過後に再び落下可能にする
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

    // バンパーの状態更新とゲームオーバー判定
    const bumperResult = updateBumpers();
    
    // 両側のバンパーが同時に閾値以上押し込まれた場合、ゲームオーバー発火
    if (bumperResult.leftPressed && bumperResult.rightPressed && !gameState.isGameOver) {
        gameState.isGameOver = true;
        gameState.canDrop = false;
        
        // Matter.jsのシミュレーションを停止して完全静止させる
        if (runner) Matter.Runner.stop(runner);
        
        setWarningEffect(false); // 赤点滅をクリア
        showGameOverUI(gameState.score);
        
        // （拡張機能: gravity_sdk.js の reportScoreToGravity() を呼ぶ場合はここに追加）
    } else {
        // 片側だけ押し込まれた場合は、UI（DOM）側に警告赤点滅エフェクトを指示
        setWarningEffect(bumperResult.leftPressed || bumperResult.rightPressed);
    }

    // レンダリング用のバンパー状態パッケージ
    const renderBumperState = {
        leftBumper,
        rightBumper,
        leftPressed: bumperResult.leftPressed,
        rightPressed: bumperResult.rightPressed
    };

    // Canvasへの描画
    renderGame(ctx, world, gameState, renderBumperState);
}

// ==========================================
// リサイズと起動シーケンス
// ==========================================
function handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    
    // 画面アスペクト比を維持しながら最大化
    const scaleX = w / GAME_WIDTH;
    const scaleY = h / GAME_HEIGHT;
    const scale = Math.min(scaleX, scaleY);
    
    canvas.width = GAME_WIDTH;
    canvas.height = GAME_HEIGHT;
    canvas.style.width = `${GAME_WIDTH * scale}px`;
    canvas.style.height = `${GAME_HEIGHT * scale}px`;
    
    // 入力モジュールの相対座標計算用スケールを更新
    updateScale();
}

window.onload = () => {
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');
    
    window.addEventListener('resize', handleResize);
    handleResize();
    
    // 各モジュールの初期化とコールバックのバインド
    initUI(startGame); // リトライボタン押下時にstartGameを呼ぶ
    initInput(canvas, handlePointerMove, handlePointerDrop);
    
    // ゲーム開始とメインループの起動
    startGame();
    requestAnimationFrame(gameLoop);
};