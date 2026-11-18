/**
 * jelly.js
 * ソフトボディゼリーの合体・成長ロジックを管理するモジュール
 * 
 * 複雑なソフトボディ同士が接触した際、古いボディ（コンポジット）を破棄し、
 * 一段階大きなソフトボディを安全に再構築します。
 * GCスパイク（画面カクつき）を防ぐため、配列再代入を禁止しインプレース更新を徹底します。
 */

import Matter from 'https://esm.sh/matter-js';
import { JELLY_CONFIG, PHYSICS } from '/sobosuba/constants.js';
import { createSoftBodyJelly } from '/sobosuba/softbody.js';
import { playSoundCollide, playSoundMerge } from '/sobosuba/sound.js';

const Composite = Matter.Composite;
const Body = Matter.Body;

// ==========================================
// ゼロアロケーション（GCスパイク根絶）用バッファ
// ==========================================
// 毎フレームの合体処理で新規配列を生成(new Array や [])せず、
// 同じメモリ番地の配列を使い回すことでガベージコレクションの発生を抑えます。
const compositesToRemove = [];
const compositesToAdd = [];

// ★追加: 接触即合体を防ぐためのディレイキューと待機時間
const pendingMerges = [];
const MERGE_DELAY_MS = 60; // 接触から合体実行までの猶予時間（約3〜4フレーム）

/**
 * 衝突イベントを処理し、同じ数字のソフトボディ同士を合体キューに入れる
 * @param {Object} event - Matter.js の collisionStart イベントオブジェクト
 * @returns {number} このフレームで獲得した合計スコア
 */
export function handleCollisions(event) {
    let earnedScore = 0;
    const pairs = event.pairs;
    
    for (let i = 0; i < pairs.length; i++) {
        const bodyA = pairs[i].bodyA;
        const bodyB = pairs[i].bodyB;
        
        // --- 衝突音の判定と再生 ---
        // コアまたはパーティクル同士の衝突の場合、相対速度を計算して音を鳴らす
        if ((bodyA.label === 'jelly_core' || bodyA.label === 'jelly_particle') &&
            (bodyB.label === 'jelly_core' || bodyB.label === 'jelly_particle')) {
            
            const relVelX = bodyA.velocity.x - bodyB.velocity.x;
            const relVelY = bodyA.velocity.y - bodyB.velocity.y;
            const relSpeed = Math.sqrt(relVelX * relVelX + relVelY * relVelY);
            
            // 一定以上の強さでぶつかった場合のみ接触音を鳴らす
            if (relSpeed > 1.5) {
                const intensity = Math.min(1.0, relSpeed / 10);
                playSoundCollide(intensity);
            }
        }

        // --- 合体判定 ---
        // 双方ともにゼリーの構成要素（コアまたはパーティクル）であるか確認
        if (bodyA.jellyId && bodyB.jellyId) {
            // 異なるゼリー同士であり、かつ数字が同じである場合
            if (bodyA.jellyId !== bodyB.jellyId && bodyA.jellyValue === bodyB.jellyValue) {
                const compA = bodyA.parentComposite;
                const compB = bodyB.parentComposite;

                // 双方のソフトボディがまだ合体処理中(_isMerging)ではない場合
                if (!compA.isMerging && !compB.isMerging) {
                    
                    // GRAVITY規格: 同一フレーム内での多重発火の即時遮断（排他ロック）
                    compA.isMerging = true;
                    compB.isMerging = true;
                    
                    const midX = (bodyA.position.x + bodyB.position.x) / 2;
                    const midY = (bodyA.position.y + bodyB.position.y) / 2;
                    const newValue = bodyA.jellyValue * 2;
                    
                    // ★修正: 即時合体させず、ディレイキューに保留する
                    pendingMerges.push({
                        compA: compA,
                        compB: compB,
                        x: midX,
                        y: midY,
                        value: newValue,
                        executeTime: Date.now() + MERGE_DELAY_MS
                    });
                    
                    // スコアを加算
                    earnedScore += newValue;
                }
            }
        }
    }
    
    return earnedScore;
}

/**
 * 物理演算の更新(afterUpdate)後に、安全にソフトボディの追加・削除を行う
 * @param {Matter.World} world - 現在の物理世界
 */
export function handleMerges(world) {
    const now = Date.now();

    // 1. ディレイキューをチェックし、猶予時間が経過したものを実行キューへ移す
    for (let i = pendingMerges.length - 1; i >= 0; i--) {
        const pm = pendingMerges[i];
        if (now >= pm.executeTime) {
            compositesToRemove.push(pm.compA, pm.compB);
            compositesToAdd.push({ x: pm.x, y: pm.y, value: pm.value });
            pendingMerges.splice(i, 1);
        }
    }

    // 2. 削除処理
    if (compositesToRemove.length > 0) {
        for (let i = 0; i < compositesToRemove.length; i++) {
            // コンポジット（ソフトボディ全体）を物理世界から安全に除去
            Composite.remove(world, compositesToRemove[i], true);
        }
        // インプレース更新（メモリ番地を維持したまま中身を空にする）
        compositesToRemove.length = 0; 
    }
    
    // 3. 追加（合体後の成長）処理
    if (compositesToAdd.length > 0) {
        for (let i = 0; i < compositesToAdd.length; i++) {
            const data = compositesToAdd[i];
            // 設定値が存在するかチェックし、存在しない場合は現状の値を維持（見た目は最大値にフォールバックされる）
            const val = JELLY_CONFIG[data.value] ? data.value : data.value; 
            
            // 新しい一段階大きなソフトボディを生成して世界に追加
            // ※スリングショットの初速は合体時には不要なため null を渡す
            const newJellyComposite = createSoftBodyJelly(data.x, data.y, val, null);
            Composite.add(world, newJellyComposite);

            // ★サウンド連携: 合体音を再生する
            playSoundMerge();

            // ==========================================
            // 連鎖合体（Radial Force）の発生
            // ==========================================
            const radius = JELLY_CONFIG[val] ? JELLY_CONFIG[val].radius : 150;
            const effectRadius = radius * 2.5; // 影響範囲（自身のサイズの2.5倍程度）
            
            const allBodies = Composite.allBodies(world);
            for (let j = 0; j < allBodies.length; j++) {
                const body = allBodies[j];
                
                // ソフトボディの構成要素にのみ力を加える
                if (body.label === 'jelly_core' || body.label === 'jelly_particle') {
                    const dx = body.position.x - data.x;
                    const dy = body.position.y - data.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    
                    // 影響範囲内にいる他のゼリーに対して外向きの力を適用
                    if (dist > 0 && dist < effectRadius) {
                        // 近いほど強く、遠いほど弱い力になるよう減衰させる
                        const forceMagnitude = PHYSICS.MERGE_RADIAL_FORCE * (1 - (dist / effectRadius));
                        
                        Body.applyForce(body, body.position, {
                            x: (dx / dist) * forceMagnitude,
                            y: (dy / dist) * forceMagnitude
                        });
                    }
                }
            }
        }
        compositesToAdd.length = 0;
    }
}