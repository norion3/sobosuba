/**
 * render.js
 * Canvas 2D コンテキストへのゼリー描画、待機プレビュー、
 * およびバンパーの赤色警告エフェクトを描画するレンダリングモジュール
 */

import { GAME_WIDTH, GAME_HEIGHT, JELLY_CONFIG, DROP_Y } from '/sobosuba/constants.js';

/**
 * 毎フレーム呼ばれるメインの描画処理
 * @param {CanvasRenderingContext2D} ctx - 描画先のCanvasコンテキスト
 * @param {Object} world - Matter.jsの物理世界
 * @param {Object} gameState - 現在のゲーム状態 (isGameOver, canDrop, dropX, nextValue, frameCount)
 * @param {Object} bumperState - バンパーの状態と実体 (leftBumper, rightBumper, leftPressed, rightPressed)
 */
export function renderGame(ctx, world, gameState, bumperState) {
    // 1. 背景のクリア
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // 2. ドロップガイドラインとプレビュー（待機）ゼリーの描画
    if (gameState.canDrop && !gameState.isGameOver) {
        const config = JELLY_CONFIG[gameState.nextValue];
        
        // ガイド線（落下予想ライン）
        ctx.beginPath();
        ctx.moveTo(gameState.dropX, DROP_Y);
        ctx.lineTo(gameState.dropX, GAME_HEIGHT);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]); // リセット

        // プレビューゼリー（半透明）
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(gameState.dropX, DROP_Y, config.radius, 0, 2 * Math.PI);
        ctx.fillStyle = config.color;
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }

    // 3. バンパー（スイッチ剛体）の描画
    const drawBumper = (bumper, isPressed) => {
        if (!bumper) return;
        
        // 押し込まれている(ON)場合は赤く発光、通常は暗いグレー
        ctx.fillStyle = isPressed ? '#ff4757' : '#2f3542';
        ctx.shadowColor = isPressed ? '#ff4757' : 'transparent';
        ctx.shadowBlur = isPressed ? 15 : 0;
        
        ctx.beginPath();
        const bw = bumper.bounds.max.x - bumper.bounds.min.x;
        const bh = bumper.bounds.max.y - bumper.bounds.min.y;
        // 角丸四角形で描画
        if (ctx.roundRect) {
            ctx.roundRect(bumper.bounds.min.x, bumper.bounds.min.y, bw, bh, 4);
        } else {
            ctx.rect(bumper.bounds.min.x, bumper.bounds.min.y, bw, bh); // 古いブラウザ用フォールバック
        }
        ctx.fill();
        
        ctx.shadowBlur = 0; // 他の描画に影響しないようリセット
    };

    drawBumper(bumperState.leftBumper, bumperState.leftPressed);
    drawBumper(bumperState.rightBumper, bumperState.rightPressed);

    // 4. 物理エンジン内のすべての剛体（ゼリー）の描画
    // グローバルのMatterオブジェクトを使用
    const bodies = Matter.Composite.allBodies(world);
    
    for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        if (body.label === 'jelly') {
            const config = JELLY_CONFIG[body.jellyValue] || JELLY_CONFIG[8192];
            const pos = body.position;
            const angle = body.angle;

            ctx.save();
            ctx.translate(pos.x, pos.y);
            ctx.rotate(angle);

            // ゼリー本体（円）
            ctx.beginPath();
            ctx.arc(0, 0, config.radius, 0, 2 * Math.PI);
            ctx.fillStyle = config.color;
            ctx.fill();
            
            // ぷにぷに感・立体感を出すためのハイライト（左上に白い半透明の円）
            ctx.beginPath();
            ctx.arc(-config.radius * 0.3, -config.radius * 0.3, config.radius * 0.2, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.fill();

            // テキスト（数字）の描画
            // 剛体の回転を相殺（逆回転）して、数字が常に水平で読めるようにする
            ctx.rotate(-angle);
            ctx.fillStyle = config.text;
            ctx.font = `bold ${Math.max(14, config.radius * 0.55)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(body.jellyValue, 0, 0);

            ctx.restore();
        }
    }

    // 5. 警告エフェクト（片方または両方のバンパーが押し込まれている時に画面を赤く明滅）
    if ((bumperState.leftPressed || bumperState.rightPressed) && !gameState.isGameOver) {
        // frameCountを利用してサイン波で柔らかく明滅させる
        const alpha = Math.abs(Math.sin(gameState.frameCount * 0.1)) * 0.15;
        ctx.fillStyle = `rgba(255, 71, 87, ${alpha})`;
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }
}