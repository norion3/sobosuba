/**
 * main.js
 * sobosuba風パズル（ソフトボディ版）のマスター統合モジュール
 * 
 * GRAVITY規格に準拠するため、全てのモジュールを絶対パスでインポートし、
 * Matter.jsの物理シミュレーションと描画ループを統合・管理します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, UI, JELLY_CONFIG, DROP_Y } from '/sobosuba/constants.js';
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
    frameCount: 0
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
    
    // UIのリセット
    updateScoreUI(gameState.score);
    hideGameOverUI();
    setWarningEffect(false);
    pickNextValue();

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
// ゼリー落下と次弾補充ロジック
// ==========================================
function pickNextValue() {
    const rand = Math.random();
    // スコアに応じて大きい数字が出やすくなる確率調整
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
    
    // 左右の壁・バンパーにめり込まないように投下X座標を制限(クランプ)
    gameState.dropX = Math.max(r + 24, Math.min(GAME_WIDTH - r - 24, relativeX));
}

function handlePointerDrop() {
    if (gameState.isGameOver || !gameState.canDrop) return;
    
    // 新しいソフトボディ（ぐにゃぐにゃ剛体）を生成して投下
    const newComposite = createSoftBodyJelly(gameState.dropX, DROP_Y, gameState.nextValue, true);
    Matter.Composite.add(world, newComposite);
    
    gameState.canDrop = false;
    pickNextValue();
    
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

    // Canvasへのレンダリング（メタボール描画）
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
    initInput(canvas, handlePointerMove, handlePointerDrop);
    
    // ゲーム開始
    startGame();
    requestAnimationFrame(gameLoop);
};