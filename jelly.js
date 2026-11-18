/**
 * jelly.js
 * ソフトボディゼリーの合体・成長ロジックを管理するモジュール
 * 
 * 複雑なソフトボディ同士が接触した際、古いボディ（コンポジット）を破棄し、
 * 一段階大きなソフトボディを安全に再構築します。
 * GCスパイク（画面カクつき）を防ぐため、配列再代入を禁止しインプレース更新を徹底します。
 */

import Matter from 'https://esm.sh/matter-js';
import { JELLY_CONFIG } from '/sobosuba/constants.js';
import { createSoftBodyJelly } from '/sobosuba/softbody.js';

const Composite = Matter.Composite;

// ==========================================
// ゼロアロケーション（GCスパイク根絶）用バッファ
// ==========================================
// 毎フレームの合体処理で新規配列を生成(new Array や [])せず、
// 同じメモリ番地の配列を使い回すことでガベージコレクションの発生を抑えます。
const compositesToRemove = [];
const compositesToAdd = [];

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
        
        // 双方ともにゼリーの構成要素（コアまたはパーティクル）であるか確認
        if (bodyA.jellyId && bodyB.jellyId) {
            // 異なるゼリー同士であり、かつ数字が同じである場合
            if (bodyA.jellyId !== bodyB.jellyId && bodyA.jellyValue === bodyB.jellyValue) {
                const compA = bodyA.parentComposite;
                const compB = bodyB.parentComposite;

                // 双方のソフトボディがまだ合体処理中(_isMerging)ではない場合
                if (!compA.isMerging && !compB.isMerging) {
                    
                    // GRAVITY規格: 同一フレーム内での多重発火の即時遮断（排他ロック）
                    // コンポジット全体に合体中フラグを立てる
                    compA.isMerging = true;
                    compB.isMerging = true;
                    
                    // 削除キューへ追加
                    compositesToRemove.push(compA, compB);
                    
                    // 2つの接触した部分（剛体）のちょうど中間地点に新しいゼリーを生成する
                    const midX = (bodyA.position.x + bodyB.position.x) / 2;
                    const midY = (bodyA.position.y + bodyB.position.y) / 2;
                    const newValue = bodyA.jellyValue * 2;
                    
                    // 生成キューへ追加
                    compositesToAdd.push({ x: midX, y: midY, value: newValue });
                    
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
    // 削除処理
    if (compositesToRemove.length > 0) {
        for (let i = 0; i < compositesToRemove.length; i++) {
            // コンポジット（ソフトボディ全体）を物理世界から安全に除去
            Composite.remove(world, compositesToRemove[i], true);
        }
        // インプレース更新（メモリ番地を維持したまま中身を空にする）
        compositesToRemove.length = 0; 
    }
    
    // 追加（合体後の成長）処理
    if (compositesToAdd.length > 0) {
        for (let i = 0; i < compositesToAdd.length; i++) {
            const data = compositesToAdd[i];
            // 設定値が存在するかチェックし、存在しない場合は現状の値を維持（見た目は最大値にフォールバックされる）
            const val = JELLY_CONFIG[data.value] ? data.value : data.value; 
            
            // 新しい一段階大きなソフトボディを生成して世界に追加
            const newJellyComposite = createSoftBodyJelly(data.x, data.y, val, false);
            Composite.add(world, newJellyComposite);
        }
        compositesToAdd.length = 0;
    }
}