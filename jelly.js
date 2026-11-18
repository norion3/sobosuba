/**
 * jelly.js
 * ゼリー（剛体）の生成、同数字衝突時の合体ロジック、および
 * GCスパイク（画面カクつき）を防ぐための配列インプレース更新を管理するモジュール
 */

import { JELLY_CONFIG, PHYSICS } from '/sobosuba/constants.js';

const Bodies = Matter.Bodies;
const Body = Matter.Body;
const Composite = Matter.Composite;

// ==========================================
// ゼロアロケーション（GCスパイク根絶）用バッファ
// ==========================================
// 毎フレームの合体処理で新規配列を生成(new Array や [])せず、
// 同じメモリ番地の配列を使い回すことでガベージコレクションの発生を抑えます。
const bodiesToRemove = [];
const bodiesToAdd = [];

/**
 * 新しいゼリー剛体を生成する
 * @param {number} x - X座標
 * @param {number} y - Y座標
 * @param {number} value - ゼリーの数値 (1, 2, 4, 8...)
 * @param {boolean} isDropping - プレイヤーが上から落とした直後かどうか
 * @returns {Matter.Body} 生成されたゼリーの剛体
 */
export function createJelly(x, y, value, isDropping = false) {
    // 定義にない巨大な数字になった場合は最大値(8192)の見た目をフォールバックとして使う
    const config = JELLY_CONFIG[value] || JELLY_CONFIG[8192];
    const radius = config.radius;
    
    const body = Bodies.circle(x, y, radius, {
        restitution: PHYSICS.RESTITUTION, // ぷにぷに感のための反発
        friction: PHYSICS.FRICTION,
        density: PHYSICS.DENSITY_BASE * (radius / 10), // 大きいほど重くして沈みやすくする
        label: 'jelly'
    });
    
    // カスタムプロパティの付与
    body.jellyValue = value;
    body.isMerging = false; // GRAVITY規格: 多重発火防止フラグ
    
    if (isDropping) {
        // 落下時は初速を下向きに与えてスムーズに落とす
        Body.setVelocity(body, { x: 0, y: 3 });
    }
    
    return body;
}

/**
 * 衝突イベントを処理し、同じ数字のゼリー同士を合体キューに入れる
 * @param {Object} event - Matter.js の collisionStart イベントオブジェクト
 * @returns {number} このフレームで獲得した合計スコア
 */
export function handleCollisions(event) {
    let earnedScore = 0;
    const pairs = event.pairs;
    
    for (let i = 0; i < pairs.length; i++) {
        const bodyA = pairs[i].bodyA;
        const bodyB = pairs[i].bodyB;
        
        // 双方ともにゼリーであるか確認
        if (bodyA.label === 'jelly' && bodyB.label === 'jelly') {
            // 数字が同じ、かつ双方ともまだ合体処理中(_isMerging)ではない場合
            if (bodyA.jellyValue === bodyB.jellyValue && !bodyA.isMerging && !bodyB.isMerging) {
                
                // GRAVITY規格: 同一フレーム内での多重発火の即時遮断（排他ロック）
                bodyA.isMerging = true;
                bodyB.isMerging = true;
                
                // 削除キューへ追加
                bodiesToRemove.push(bodyA, bodyB);
                
                // 2つのゼリーのちょうど中間地点に新しいゼリーを生成する
                const midX = (bodyA.position.x + bodyB.position.x) / 2;
                const midY = (bodyA.position.y + bodyB.position.y) / 2;
                const newValue = bodyA.jellyValue * 2;
                
                // 生成キューへ追加
                bodiesToAdd.push({ x: midX, y: midY, value: newValue });
                
                // スコアを加算
                earnedScore += newValue;
            }
        }
    }
    
    return earnedScore;
}

/**
 * 物理演算の更新(afterUpdate)後に、安全にゼリーの追加・削除を行う
 * @param {Matter.World} world - 現在の物理世界
 */
export function handleMerges(world) {
    // 削除処理
    if (bodiesToRemove.length > 0) {
        Composite.remove(world, bodiesToRemove);
        // インプレース更新（メモリ番地を維持したまま中身を空にする）
        bodiesToRemove.length = 0; 
    }
    
    // 追加（合体後の成長）処理
    if (bodiesToAdd.length > 0) {
        for (let i = 0; i < bodiesToAdd.length; i++) {
            const data = bodiesToAdd[i];
            // 設定値が存在するかチェックし、存在しない場合は値だけ増やす（見た目は最大値に丸められる）
            const val = JELLY_CONFIG[data.value] ? data.value : data.value; 
            const newBody = createJelly(data.x, data.y, val);
            Composite.add(world, newBody);
        }
        bodiesToAdd.length = 0;
    }
}