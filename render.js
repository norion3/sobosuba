/**
 * render.js
 * ソフトボディのパーティクル群を滑らかなスライムとして描画するレンダリングモジュール
 * 
 * 外殻パーティクルの座標をベジェ曲線で結び、中身を塗りつぶすことで、
 * モバイルブラウザでも軽量に「ぐにゃぐにゃ感」を表現します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, JELLY_CONFIG, DROP_Y, EFFECTS } from '/sobosuba/constants.js';

/**
 * 毎フレーム呼ばれるメインの描画処理
 * @param {CanvasRenderingContext2D} ctx - 描画先のCanvasコンテキスト
 * @param {Object} world - Matter.jsの物理世界
 * @param {Object} gameState - 現在のゲーム状態 (isGameOver, canDrop, dropX, nextValue, frameCount, isDragging, dragStartX, dragCurrentX, dragStartY, dragCurrentY)
 * @param {Object} bumperState - バンパーの状態と実体 (leftBumper, rightBumper, leftPressed, rightPressed)
 */
export function renderGame(ctx, world, gameState, bumperState) {
    // 1. 背景のクリア
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // 2. ドロップガイドライン / 照準矢印 とプレビュー（待機）ゼリーの描画
    if (gameState.canDrop && !gameState.isGameOver) {
        const config = JELLY_CONFIG[gameState.nextValue] || JELLY_CONFIG[1];
        
        if (gameState.isDragging) {
            // --- スリングショット：引っ張り中の照準矢印の描画 ---
            // 引っ張った方向と逆向きのベクトルを計算
            const dx = gameState.dragStartX - gameState.dragCurrentX;
            const dy = gameState.dragStartY - gameState.dragCurrentY;
            
            ctx.beginPath();
            ctx.moveTo(gameState.dropX, DROP_Y);
            ctx.lineTo(gameState.dropX + dx, DROP_Y + dy);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.lineWidth = 4;
            ctx.setLineDash([10, 10]);
            ctx.stroke();
            ctx.setLineDash([]); // リセット
            
            // 矢印の先端（ヘッド）を描画
            const angle = Math.atan2(dy, dx);
            const headlen = 16;
            ctx.beginPath();
            ctx.moveTo(gameState.dropX + dx, DROP_Y + dy);
            ctx.lineTo(gameState.dropX + dx - headlen * Math.cos(angle - Math.PI / 6), DROP_Y + dy - headlen * Math.sin(angle - Math.PI / 6));
            ctx.lineTo(gameState.dropX + dx - headlen * Math.cos(angle + Math.PI / 6), DROP_Y + dy - headlen * Math.sin(angle + Math.PI / 6));
            ctx.lineTo(gameState.dropX + dx, DROP_Y + dy);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.fill();

            // プレビューゼリー（引っ張り中は少し濃く表示）
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.arc(gameState.dropX, DROP_Y, config.radius, 0, 2 * Math.PI);
            ctx.fillStyle = config.color;
            ctx.fill();
            
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#000000';
            ctx.stroke();

            ctx.fillStyle = config.text;
            ctx.font = `900 ${Math.max(14, config.radius * 0.6)}px "Courier New", Courier, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(gameState.nextValue, gameState.dropX, DROP_Y);

            ctx.globalAlpha = 1.0;
            
        } else {
            // --- 通常時：真下へのドロップガイドライン ---
            ctx.beginPath();
            ctx.moveTo(gameState.dropX, DROP_Y);
            ctx.lineTo(gameState.dropX, GAME_HEIGHT);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 6]);
            ctx.stroke();
            ctx.setLineDash([]); // リセット

            // プレビューゼリー（半透明）
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.arc(gameState.dropX, DROP_Y, config.radius, 0, 2 * Math.PI);
            ctx.fillStyle = config.color;
            ctx.fill();

            ctx.lineWidth = 3;
            ctx.strokeStyle = '#000000';
            ctx.stroke();

            ctx.fillStyle = config.text;
            ctx.font = `900 ${Math.max(14, config.radius * 0.6)}px "Courier New", Courier, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(gameState.nextValue, gameState.dropX, DROP_Y);

            ctx.globalAlpha = 1.0;
        }
    }

    // 3. バンパー（スイッチ剛体）の描画
    const drawBumper = (bumper, isPressed) => {
        if (!bumper) return;
        
        // 押し込まれている(ON)場合は赤く発光、通常は暗いグレー
        ctx.fillStyle = isPressed ? '#ff1e46' : '#2f3542';
        ctx.shadowColor = isPressed ? '#ff1e46' : 'transparent';
        ctx.shadowBlur = isPressed ? 15 : 0;
        
        ctx.beginPath();
        const bw = bumper.bounds.max.x - bumper.bounds.min.x;
        const bh = bumper.bounds.max.y - bumper.bounds.min.y;
        
        if (ctx.roundRect) {
            ctx.roundRect(bumper.bounds.min.x, bumper.bounds.min.y, bw, bh, 4);
        } else {
            ctx.rect(bumper.bounds.min.x, bumper.bounds.min.y, bw, bh); // 古いブラウザ用
        }
        ctx.fill();
        
        ctx.shadowBlur = 0; // 他の描画に影響しないようリセット
    };

    drawBumper(bumperState.leftBumper, bumperState.leftPressed);
    drawBumper(bumperState.rightBumper, bumperState.rightPressed);

    // 4. ソフトボディ（スライム）の描画
    const composites = Matter.Composite.allComposites(world);
    const durationMs = EFFECTS.MERGE_EXPAND_FRAMES * (1000 / 60); // 膨張アニメーションの想定持続時間
    
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        
        // ゼリーのソフトボディ・コンポジットのみを描画対象とする
        if (comp.label === 'jelly_composite') {
            // コアと外周パーティクルの分離
            let core = null;
            const particles = [];
            
            for (let j = 0; j < comp.bodies.length; j++) {
                const b = comp.bodies[j];
                if (b.label === 'jelly_core') core = b;
                else if (b.label === 'jelly_particle') particles.push(b);
            }

            if (!core || particles.length === 0) continue;

            const config = JELLY_CONFIG[core.jellyValue] || JELLY_CONFIG[8192];

            ctx.save();
            
            // --- 膨張アニメーションスケールの計算と適用 ---
            let scale = 1.0;
            if (core.createdAt) {
                const elapsedMs = Date.now() - core.createdAt;
                if (elapsedMs < durationMs) {
                    const progress = elapsedMs / durationMs;
                    // 0〜1の進行度からサイン波で 1.0 -> MERGE_EXPAND_SCALE -> 1.0 に変化
                    scale = 1.0 + Math.sin(progress * Math.PI) * (EFFECTS.MERGE_EXPAND_SCALE - 1.0);
                }
            }

            ctx.translate(core.position.x, core.position.y);
            ctx.scale(scale, scale);
            ctx.translate(-core.position.x, -core.position.y);

            // --- Blob（スライム）形状の描画 ---
            ctx.beginPath();
            
            // 最初のパーティクルと最後のパーティクルの中間点を開始点とする
            let xc = (particles[0].position.x + particles[particles.length - 1].position.x) / 2;
            let yc = (particles[0].position.y + particles[particles.length - 1].position.y) / 2;
            ctx.moveTo(xc, yc);

            // 各パーティクルを制御点として、二次ベジェ曲線（quadraticCurveTo）で滑らかに結ぶ
            for (let j = 0; j < particles.length; j++) {
                const nextP = particles[(j + 1) % particles.length];
                xc = (particles[j].position.x + nextP.position.x) / 2;
                yc = (particles[j].position.y + nextP.position.y) / 2;
                ctx.quadraticCurveTo(particles[j].position.x, particles[j].position.y, xc, yc);
            }
            
            ctx.fillStyle = config.color;
            ctx.fill();
            
            // 輪郭線（本家準拠：黒く太い境界線でフラットなデザインにする）
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#000000';
            ctx.stroke();

            // ※スイカゲーム風の白い立体ハイライトは本家デザイン準拠のため削除しました

            ctx.restore(); // スライム形状のスケールをリセット

            // --- 数字の描画 ---
            ctx.save();
            ctx.translate(core.position.x, core.position.y);
            
            // 本家準拠：ゼリーの傾きに合わせて数字も一緒に回転（追従）させる
            ctx.rotate(core.angle);
            // 数字にも膨張スケールを適用する
            ctx.scale(scale, scale);
            
            ctx.fillStyle = config.text;
            // 本家準拠：角張ったデジタル・ピクセル風フォントに変更
            ctx.font = `900 ${Math.max(14, config.radius * 0.6)}px "Courier New", Courier, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(core.jellyValue, 0, 0);
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