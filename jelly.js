/**
 * jelly.js
 * @version v2.0 (Bugfix Step 5)
 * @changes
 *   - リトライ時のゴーストゼリー発生を防ぐため、合体待機・削除・追加キューをインプレース初期化する resetMergeQueues() を新設
 *   - 上部フロートバー上での合体時に左右の壁へめり込まないよう、生成X座標をバーの有効幅内へクランプする処理を追加
 *   - GRAVITYキャッシュ不整合対策として修正対象モジュール（constants.js / softbody.js）の絶対パスに ?v=2 を付与
 * 
 * ソフトボディゼリーの合体・成長ロジックを管理するモジュール
 * 
 * 複雑なソフトボディ同士が接触した際、古いボディ（コンポジット）を破棄し、
 * 一段階大きなソフトボディを安全に再構築します。
 * 上部フロートバー上での事前合体（バー上に留まる処理）と、
 * フィールド内合体時の衝撃波（Radial Force）を管理します。
 * GCスパイク（画面カクつき）を防ぐため、配列再代入を禁止しインプレース更新を徹底します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, JELLY_CONFIG, PHYSICS, FLOAT_BAR } from '/sobosuba/constants.js?v=2';
import { createSoftBodyJelly } from '/sobosuba/softbody.js?v=2';
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

// 接触即合体を防ぐためのディレイキューと待機時間
const pendingMerges = [];
const MERGE_DELAY_MS = 60; // 接触から合体実行までの猶予時間（約3〜4フレーム）

/**
 * リトライ時に合体待機・削除・追加キューをインプレースで初期化する（ゴーストゼリー防止）
 */
export function resetMergeQueues() {
    pendingMerges.length = 0;
    compositesToRemove.length = 0;
    compositesToAdd.length = 0;
}

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

                // 双方のソフトボディがまだ合体処理中(isMerging)ではない場合
                if (compA && compB && !compA.isMerging && !compB.isMerging) {
                    
                    // GRAVITY規格: 同一フレーム内での多重発火の即時遮断（排他ロック）
                    compA.isMerging = true;
                    compB.isMerging = true;
                    
                    // 双方とも上部フロートバー上のゼリーであれば、合体後もバー上に留める
                    const isFloatingMerge = Boolean(compA.isFloating && compB.isFloating);

                    // コアが存在すればコア同士の中間点、なければ接触剛体同士の中間点を算出
                    const posA = compA.core ? compA.core.position : bodyA.position;
                    const posB = compB.core ? compB.core.position : bodyB.position;
                    const midX = (posA.x + posB.x) / 2;
                    const midY = isFloatingMerge ? FLOAT_BAR.Y : (posA.y + posB.y) / 2;
                    const newValue = bodyA.jellyValue * 2;
                    
                    // 即時合体させず、ディレイキューに保留する
                    pendingMerges.push({
                        compA: compA,
                        compB: compB,
                        x: midX,
                        y: midY,
                        value: newValue,
                        isFloating: isFloatingMerge,
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
            compositesToAdd.push({
                x: pm.x,
                y: pm.y,
                value: pm.value,
                isFloating: pm.isFloating
            });
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

            // バー上合体時に左右の壁へめり込まないよう、生成X座標をバーの有効幅内へクランプする
            let spawnX = data.x;
            if (data.isFloating) {
                const newConfig = JELLY_CONFIG[val] || JELLY_CONFIG[8192];
                const minX = FLOAT_BAR.PADDING_X + newConfig.radius;
                const maxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - newConfig.radius;
                spawnX = (minX <= maxX) ? Math.max(minX, Math.min(maxX, spawnX)) : (GAME_WIDTH / 2);
            }
            
            // 新しい一段階大きなソフトボディを生成して世界に追加
            // バー上での事前合体の場合は isFloating = true としてバー上に留める
            const newJellyComposite = createSoftBodyJelly(spawnX, data.y, val, null, data.isFloating);
            Composite.add(world, newJellyComposite);

            // サウンド連携: 合体音を再生する
            playSoundMerge();

            // ==========================================
            // フィールド内合体時の連鎖衝撃波（Radial Force）の発生
            // ==========================================
            // バー上での事前合体時は待機列を吹き飛ばさないよう衝撃波をスキップする
            if (!data.isFloating) {
                const radius = JELLY_CONFIG[val] ? JELLY_CONFIG[val].radius : 150;
                const effectRadius = radius * 2.5; // 影響範囲（自身のサイズの2.5倍程度）
                
                const allBodies = Composite.allBodies(world);
                for (let j = 0; j < allBodies.length; j++) {
                    const body = allBodies[j];
                    
                    // フィールド内のソフトボディの構成要素にのみ力を加える（バー上の待機ゼリーは除外）
                    if ((body.label === 'jelly_core' || body.label === 'jelly_particle') &&
                        (!body.parentComposite || !body.parentComposite.isFloating)) {
                        const dx = body.position.x - spawnX;
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
        }
        compositesToAdd.length = 0;
    }
}