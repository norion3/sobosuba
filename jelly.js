/**
 * jelly.js
 * @version v4.0 (Final Overhaul Step 7)
 * @changes
 *   - 合体時の絡み合い・重なり合いを根絶するため、合体生成時に縮小スポーン倍率（EFFECTS.MERGE_GROW_START_SCALE = 0.75）を渡して膨張成長（Grow-In）させる方式へ変更
 *   - SUBSTEPS=4 正規化に合わせ、衝突音判定を PHYSICS.COLLIDE_SOUND_MIN_SPEED / MAX_SPEED 基準へ修正し、ゼリーサイズ連動衝突音 playSoundCollide(intensity, jellyValue) へ連携
 *   - SUBSTEPS=4 下での衝撃波減衰を解消するため、フィールド内合体時の周囲押し出しを力ベースから速度インパルス（PHYSICS.MERGE_RADIAL_IMPULSE）＋最大速度クランプ方式へ刷新
 *   - 下段巨大ゼリーの吸い上げグリッチを防ぐため、バー上留まり合体を「双方ともバー上（ホップ中含む）かつ上限値以下」または「上限値以下でバー高度付近の合体」へ安全条件化
 *   - GRAVITYキャッシュ不整合対策として constants.js / softbody.js / sound.js の絶対パスを ?v=4 へ統一
 * 
 * ソフトボディゼリー（Sobo）の合体・成長ロジックを管理するモジュール
 * 
 * 複雑な中空ビーズリング同士が接触した際、古いコンポジットを破棄し、
 * 一段階大きなソフトボディを縮小スポーン→膨張成長で安全に再構築します。
 * 上部フロートバー上での事前合体（ホップ着地合体含む）と、
 * フィールド内合体時の膨張インパルス（Radial Impulse）を管理します。
 * GCスパイク（画面カクつき）を防ぐため、配列再代入を禁止しインプレース更新を徹底します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, JELLY_CONFIG, PHYSICS, FLOAT_BAR, EFFECTS, SCORE } from '/sobosuba/constants.js?v=4';
import { createSoftBodyJelly, getSoftBodyCentroid } from '/sobosuba/softbody.js?v=4';
import { playSoundCollide, playSoundMerge } from '/sobosuba/sound.js?v=4';

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
    const radius = config ? config.radius : 16;
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
    const minCollideSpeed = PHYSICS.COLLIDE_SOUND_MIN_SPEED || 0.55;
    const maxCollideSpeed = PHYSICS.COLLIDE_SOUND_MAX_SPEED || 3.0;
    const maxBarMergeValue = FLOAT_BAR.BAR_MERGE_MAX_VALUE || 512;
    const barAttachMaxY = (FLOAT_BAR.HOP_RECATCH_Y_MAX || (FLOAT_BAR.Y + 26)) + 16;

    for (let i = 0; i < pairs.length; i++) {
        const bodyA = pairs[i].bodyA;
        const bodyB = pairs[i].bodyB;

        // --- 衝突音の判定と再生（SUBSTEPS=4 正規化 ＆ ゼリーサイズ連動ピッチ） ---
        if (allowCollideSound &&
            bodyA.label === 'jelly_particle' &&
            bodyB.label === 'jelly_particle' &&
            bodyA.jellyId !== bodyB.jellyId) {

            const relVelX = bodyA.velocity.x - bodyB.velocity.x;
            const relVelY = bodyA.velocity.y - bodyB.velocity.y;
            const relSpeed = Math.sqrt(relVelX * relVelX + relVelY * relVelY);

            // SUBSTEPS=4 正規化済みの相対速度閾値を超えた場合のみサイズ連動衝突音を鳴らす
            if (relSpeed > minCollideSpeed) {
                const intensity = Math.min(1.0, relSpeed / maxCollideSpeed);
                const valA = bodyA.jellyValue || 1;
                const valB = bodyB.jellyValue || 1;
                const combinedSizeValue = Math.sqrt(valA * valB);
                playSoundCollide(intensity, combinedSizeValue);
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

                    // 中空ビーズリングの現在重心を基準に中間点を算出
                    const posA = getSoftBodyCentroid(compA) || bodyA.position;
                    const posB = getSoftBodyCentroid(compB) || bodyB.position;
                    const midX = (posA.x + posB.x) / 2;
                    const rawMidY = (posA.y + posB.y) / 2;
                    const newValue = bodyA.jellyValue * 2;

                    // バー上合体の安全条件化（下段巨大ゼリーの吸い上げグリッチ防止 ＆ 上段ホップ着地合体対応）
                    // 1. 双方とも上段（浮遊中またはホップ中）かつ上限サイズ以下 → 確実に上段バーへ留める
                    // 2. 片方が上段かつ上限サイズ以下で、接触位置がバー高度付近にある場合のみ上段バーへ留める
                    const aOnBar = Boolean(compA.isFloating || compA.isBarHopping);
                    const bOnBar = Boolean(compB.isFloating || compB.isBarHopping);
                    const isWithinBarLimit = newValue <= maxBarMergeValue;
                    const isFloatingMerge = isWithinBarLimit && (
                        (aOnBar && bOnBar) ||
                        ((aOnBar || bOnBar) && rawMidY <= barAttachMaxY)
                    );

                    const midY = isFloatingMerge ? FLOAT_BAR.Y : rawMidY;
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
        const growStartScale = EFFECTS.MERGE_GROW_START_SCALE || 0.75;
        const baseImpulse = PHYSICS.MERGE_RADIAL_IMPULSE || 1.45;
        const maxSpeed = PHYSICS.MAX_PARTICLE_SPEED || 4.5;
        const maxSpeedSq = maxSpeed * maxSpeed;

        for (let i = 0; i < compositesToAdd.length; i++) {
            const data = compositesToAdd[i];
            const val = data.value;
            const newConfig = JELLY_CONFIG[val] || JELLY_CONFIG[16384] || JELLY_CONFIG[8192];
            const newRadius = newConfig ? newConfig.radius : 16;

            // 生成座標の安全クランプ（バー上・フィールド内ともに壁・床へのめり込みを防止）
            let spawnX = data.x;
            let spawnY = data.y;
            if (data.isFloating) {
                const minX = FLOAT_BAR.PADDING_X + newRadius;
                const maxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - newRadius;
                spawnX = (minX <= maxX) ? Math.max(minX, Math.min(maxX, spawnX)) : (GAME_WIDTH / 2);
                spawnY = FLOAT_BAR.Y;
            } else {
                const spawnRadius = newRadius * growStartScale;
                const minX = spawnRadius + 4;
                const maxX = GAME_WIDTH - spawnRadius - 4;
                const minY = spawnRadius + 4;
                const maxY = GAME_HEIGHT - spawnRadius - 4;
                spawnX = (minX <= maxX) ? Math.max(minX, Math.min(maxX, spawnX)) : (GAME_WIDTH / 2);
                spawnY = (minY <= maxY) ? Math.max(minY, Math.min(maxY, spawnY)) : (GAME_HEIGHT / 2);
            }

            // 新しい一段階大きな中空ビーズリングを「縮小スポーン（0.75倍）→ 膨張成長（Grow-In）」で生成
            // 合体生成なので hasMerged = true を付与
            const newJellyComposite = createSoftBodyJelly(
                spawnX,
                spawnY,
                val,
                null,
                data.isFloating,
                true,
                growStartScale
            );

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
            // フィールド内合体時の連鎖膨張インパルス（SUBSTEPS=4 正規化済み速度インパルス）
            // ==========================================
            // バー上での事前合体時は待機列を吹き飛ばさないよう衝撃波をスキップする
            if (!data.isFloating) {
                const effectRadius = newRadius * 2.5; // 影響範囲（自身のサイズの2.5倍程度）

                const allBodies = Composite.allBodies(world);
                for (let j = 0; j < allBodies.length; j++) {
                    const body = allBodies[j];

                    // フィールド内のソフトボディの構成要素にのみ速度インパルスを加える（バー上・ホップ中・自分自身は除外）
                    if (body.label === 'jelly_particle' &&
                        body.jellyId !== newJellyComposite.jellyId &&
                        (!body.parentComposite || (!body.parentComposite.isFloating && !body.parentComposite.isBarHopping))) {
                        const dx = body.position.x - spawnX;
                        const dy = body.position.y - spawnY;
                        const dist = Math.sqrt(dx * dx + dy * dy);

                        // 影響範囲内にいる他のゼリーに対して外向きの速度インパルスを適用
                        if (dist > 0.001 && dist < effectRadius) {
                            // 近いほど強く、遠いほど弱い押し出しになるよう線形減衰させる
                            const impulseMagnitude = baseImpulse * (1 - (dist / effectRadius));
                            let vx = body.velocity.x + (dx / dist) * impulseMagnitude;
                            let vy = body.velocity.y + (dy / dist) * impulseMagnitude;

                            // すり抜け防止のため最大速度上限でクランプ
                            const speedSq = vx * vx + vy * vy;
                            if (speedSq > maxSpeedSq) {
                                const scale = maxSpeed / Math.sqrt(speedSq);
                                vx *= scale;
                                vy *= scale;
                            }
                            Body.setVelocity(body, { x: vx, y: vy });
                        }
                    }
                }
            }
        }
        compositesToAdd.length = 0;
    }
}