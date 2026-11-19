/**
 * jelly.js
 * @version v3.0 (Overhaul Step 7)
 * @changes
 *   - 中心コア廃止に伴い、中空ビーズリングの重心（getSoftBodyCentroid）ベースでの合体位置算出へ移行
 *   - 本家完全準拠のスコア計算（未合体Soboの初参加分のみ加算し、合体後のSoboへ hasMerged = true を付与）を実装
 *   - 面積に応じた合体保護ディレイ（EFFECTS.MERGE_BASE_DELAY_MS / MERGE_AREA_DELAY_FACTOR）と合体直後の保護期間（mergeProtectedUntil）を追加
 *   - 連鎖時間ウィンドウ（SCORE.CHAIN_WINDOW_MS）に応じて合体音の音程を半音ずつ上げる playSoundMerge(chainCount) へ連携
 *   - 上部フロートバー上のゼリー同士だけでなく、横当て発射や下からの跳ね返りでバー上Soboと接触した場合もバー上で合体して留まる処理へ対応
 *   - GRAVITYキャッシュ不整合対策として constants.js / softbody.js / sound.js の絶対パスを ?v=3 へ統一
 * 
 * ソフトボディゼリー（Sobo）の合体・成長ロジックを管理するモジュール
 * 
 * 複雑な中空ビーズリング同士が接触した際、古いコンポジットを破棄し、
 * 一段階大きなソフトボディを安全に再構築します。
 * 上部フロートバー上での事前合体（バー上に留まる処理）と、
 * フィールド内合体時の膨張パルス（Radial Force）を管理します。
 * GCスパイク（画面カクつき）を防ぐため、配列再代入を禁止しインプレース更新を徹底します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, JELLY_CONFIG, PHYSICS, FLOAT_BAR, EFFECTS, SCORE } from '/sobosuba/constants.js?v=3';
import { createSoftBodyJelly, getSoftBodyCentroid } from '/sobosuba/softbody.js?v=3';
import { playSoundCollide, playSoundMerge } from '/sobosuba/sound.js?v=3';

const Composite = Matter.Composite;
const Body = Matter.Body;

// ==========================================
// ゼロアロケーション（GCスパイク根絶）用バッファ
// ==========================================
// 毎フレームの合体処理で新規配列を生成(new Array や [])せず、
// 同じメモリ番地の配列を使い回すことでガベージコレクションの発生を抑えます。
const compositesToRemove = [];
const compositesToAdd = [];

// 接触即合体を防ぐためのディレイキュー
const pendingMerges = [];

// 連鎖ピッチ上昇演出用の状態管理
let lastMergeSoundTime = 0;
let currentChainCount = 0;

/**
 * ゼリーの面積に応じた合体猶予・保護時間（ms）を算出する
 * @param {number} value - ゼリーの数値
 * @returns {number} 保護・ディレイ時間（ミリ秒）
 */
function calcAreaMergeDelayMs(value) {
    const config = JELLY_CONFIG[value] || JELLY_CONFIG[16384] || JELLY_CONFIG[8192];
    const radius = config ? config.radius : 18;
    const area = Math.PI * radius * radius;
    const baseDelay = EFFECTS.MERGE_BASE_DELAY_MS || 45;
    const areaFactor = EFFECTS.MERGE_AREA_DELAY_FACTOR || 0.004;
    // 極端に長くなりすぎないよう上限を設けて快適に連鎖できる範囲に収める
    return Math.min(260, Math.round(baseDelay + area * areaFactor));
}

/**
 * リトライ時に合体待機・削除・追加キューおよび連鎖状態をインプレースで初期化する（ゴーストゼリー防止）
 */
export function resetMergeQueues() {
    pendingMerges.length = 0;
    compositesToRemove.length = 0;
    compositesToAdd.length = 0;
    lastMergeSoundTime = 0;
    currentChainCount = 0;
}

/**
 * 衝突イベントを処理し、同じ数字のソフトボディ同士を合体キューに入れる
 * @param {Object} event - Matter.js の collisionStart / collisionActive イベントオブジェクト
 * @param {boolean} allowCollideSound - 衝突音を鳴らすかどうか（collisionActive 呼び出し時は false 指定可）
 * @returns {number} このフレームで獲得した本家準拠スコア（未合体Soboの初参加分のみ）
 */
export function handleCollisions(event, allowCollideSound = true) {
    let earnedScore = 0;
    const pairs = event.pairs;
    const now = Date.now();

    for (let i = 0; i < pairs.length; i++) {
        const bodyA = pairs[i].bodyA;
        const bodyB = pairs[i].bodyB;

        // --- 衝突音の判定と再生 ---
        // パーティクル同士の衝突の場合、相対速度を計算して音を鳴らす
        if (allowCollideSound &&
            bodyA.label === 'jelly_particle' &&
            bodyB.label === 'jelly_particle' &&
            bodyA.jellyId !== bodyB.jellyId) {

            const relVelX = bodyA.velocity.x - bodyB.velocity.x;
            const relVelY = bodyA.velocity.y - bodyB.velocity.y;
            const relSpeed = Math.sqrt(relVelX * relVelX + relVelY * relVelY);

            // 一定以上の強さでぶつかった場合のみ接触音を鳴らす
            if (relSpeed > 1.8) {
                const intensity = Math.min(1.0, relSpeed / 10);
                playSoundCollide(intensity);
            }
        }

        // --- 合体判定 ---
        // 双方ともにゼリーの構成要素であるか確認
        if (bodyA.jellyId && bodyB.jellyId) {
            // 異なるゼリー同士であり、かつ数字が同じである場合
            if (bodyA.jellyId !== bodyB.jellyId && bodyA.jellyValue === bodyB.jellyValue) {
                const compA = bodyA.parentComposite;
                const compB = bodyB.parentComposite;

                // 双方のソフトボディが有効かつ合体処理中(isMerging)ではない場合
                if (compA && compB && !compA.isMerging && !compB.isMerging) {
                    // 合体直後の面積に応じた保護期間中であれば合体を見送る
                    if ((compA.mergeProtectedUntil && now < compA.mergeProtectedUntil) ||
                        (compB.mergeProtectedUntil && now < compB.mergeProtectedUntil)) {
                        continue;
                    }

                    // GRAVITY規格: 同一フレーム内での多重発火の即時遮断（排他ロック）
                    compA.isMerging = true;
                    compB.isMerging = true;

                    // 少なくとも一方が上部フロートバー上のゼリーであれば（横当て・跳ね返り合体含む）、合体後もバー上に留める
                    const isFloatingMerge = Boolean(compA.isFloating || compB.isFloating);

                    // 中空ビーズリングの現在重心を基準に中間点を算出
                    const posA = getSoftBodyCentroid(compA) || bodyA.position;
                    const posB = getSoftBodyCentroid(compB) || bodyB.position;
                    const midX = (posA.x + posB.x) / 2;
                    const midY = isFloatingMerge ? FLOAT_BAR.Y : (posA.y + posB.y) / 2;
                    const newValue = bodyA.jellyValue * 2;
                    const delayMs = calcAreaMergeDelayMs(bodyA.jellyValue);

                    // 即時合体させず、面積に応じたディレイキューに保留する
                    pendingMerges.push({
                        compA: compA,
                        compB: compB,
                        x: midX,
                        y: midY,
                        value: newValue,
                        isFloating: isFloatingMerge,
                        executeTime: now + delayMs
                    });

                    // 【本家完全準拠スコア計算】
                    // 未合体（hasMerged === false）のSoboが初めて合体に参加した分のみを加算する
                    // 既に合体済み（hasMerged === true）のSobo同士の合体は盤面総和が変わらないため +0 点
                    if (!compA.hasMerged) {
                        earnedScore += compA.jellyValue;
                    }
                    if (!compB.hasMerged) {
                        earnedScore += compB.jellyValue;
                    }
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
            // 猶予時間中の移動にも追従できるよう、実行直前の最新重心から生成座標を更新
            const latestA = getSoftBodyCentroid(pm.compA);
            const latestB = getSoftBodyCentroid(pm.compB);
            const finalX = (latestA && latestB) ? ((latestA.x + latestB.x) / 2) : pm.x;
            const finalY = pm.isFloating
                ? FLOAT_BAR.Y
                : ((latestA && latestB) ? ((latestA.y + latestB.y) / 2) : pm.y);

            compositesToRemove.push(pm.compA, pm.compB);
            compositesToAdd.push({
                x: finalX,
                y: finalY,
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
        const chainWindowMs = SCORE.CHAIN_WINDOW_MS || 1000;

        for (let i = 0; i < compositesToAdd.length; i++) {
            const data = compositesToAdd[i];
            const val = data.value;
            const newConfig = JELLY_CONFIG[val] || JELLY_CONFIG[16384] || JELLY_CONFIG[8192];
            const newRadius = newConfig ? newConfig.radius : 18;

            // 生成座標の安全クランプ（バー上・フィールド内ともに壁・床へのめり込みを防止）
            let spawnX = data.x;
            let spawnY = data.y;
            if (data.isFloating) {
                const minX = FLOAT_BAR.PADDING_X + newRadius;
                const maxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - newRadius;
                spawnX = (minX <= maxX) ? Math.max(minX, Math.min(maxX, spawnX)) : (GAME_WIDTH / 2);
                spawnY = FLOAT_BAR.Y;
            } else {
                const minX = newRadius + 4;
                const maxX = GAME_WIDTH - newRadius - 4;
                const minY = newRadius + 4;
                const maxY = GAME_HEIGHT - newRadius - 4;
                spawnX = (minX <= maxX) ? Math.max(minX, Math.min(maxX, spawnX)) : (GAME_WIDTH / 2);
                spawnY = (minY <= maxY) ? Math.max(minY, Math.min(maxY, spawnY)) : (GAME_HEIGHT / 2);
            }

            // 新しい一段階大きな中空ビーズリングを生成して世界に追加（合体生成なので hasMerged = true）
            const newJellyComposite = createSoftBodyJelly(spawnX, spawnY, val, null, data.isFloating, true);

            // 本家準拠：新しく合体したSoboに面積に応じた短い合体保護期間を付与
            const protectionMs = calcAreaMergeDelayMs(val);
            newJellyComposite.mergeProtectedUntil = now + protectionMs;
            newJellyComposite.mergeFlashUntil = now + Math.max(120, protectionMs);

            Composite.add(world, newJellyComposite);

            // サウンド連携: 連鎖ウィンドウ内であれば連鎖カウントを進めて半音ずつピッチ上昇
            if (now - lastMergeSoundTime <= chainWindowMs) {
                currentChainCount++;
            } else {
                currentChainCount = 0;
            }
            lastMergeSoundTime = now;
            playSoundMerge(currentChainCount);

            // ==========================================
            // フィールド内合体時の連鎖膨張パルス（Radial Force）の発生
            // ==========================================
            // バー上での事前合体時は待機列を吹き飛ばさないよう衝撃波をスキップする
            if (!data.isFloating) {
                const effectRadius = newRadius * 2.5; // 影響範囲（自身のサイズの2.5倍程度）

                const allBodies = Composite.allBodies(world);
                for (let j = 0; j < allBodies.length; j++) {
                    const body = allBodies[j];

                    // フィールド内のソフトボディの構成要素にのみ力を加える（バー上の待機ゼリーと自分自身は除外）
                    if (body.label === 'jelly_particle' &&
                        body.jellyId !== newJellyComposite.jellyId &&
                        (!body.parentComposite || !body.parentComposite.isFloating)) {
                        const dx = body.position.x - spawnX;
                        const dy = body.position.y - spawnY;
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