/**
 * jelly.js
 * @version v8.11 (Sync Pending Merge Execute Time with Wall-Clock Shift - Phase 2)
 * @changes
 *   - handleMerges() の吸い付き完了時刻判定を compA / compB の mergePreGlowUntil と同期（Math.max(pm.executeTime, (pm.compA && pm.compA.mergePreGlowUntil) || 0, (pm.compB && pm.compB.mergePreGlowUntil) || 0)）し、iPhone バックグラウンド復帰時の壁時計シフトと吸い付きディレイを完全同期
 * 
 * ソフトボディゼリー（Sobo）の合体・成長ロジックを管理するモジュール
 * 
 * 複雑な中空ビーズリング同士が接触した際、合体前の「吸い付きの間」に穏やかに引き寄せ合って古いコンポジットを破棄し、
 * 親2体の運動量を継承した一段階大きなソフトボディを縮小スポーン→Ease-Out-Back膨張成長で安全に再構築します。
 * 上部フロートバー上での横長カプセル事前合体（ホップ着地合体含む）と、
 * フィールド内合体時の膨張インパルス（Radial Impulse）および重心法線ベースの衝突音判定を管理します。
 * GCスパイク（画面カクつき）を防ぐため、配列再代入を禁止しインプレース更新を徹底します。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, CONTAINER, JELLY_CONFIG, PHYSICS, FLOAT_BAR, EFFECTS, SCORE } from '/sobosuba/constants.js?v=7';
import { clampPointToContainer } from '/sobosuba/physics.js?v=7';
import { createSoftBodyJelly, getSoftBodyCentroid, getCapsuleHalfExtentsForValue } from '/sobosuba/softbody.js?v=7';
import { playSoundCollide, playSoundMerge, playSoundMergeAnticipate } from '/sobosuba/sound.js?v=7';

const Composite = Matter.Composite;
const Body = Matter.Body;

// ==========================================
// ゼロアロケーション（GCスパイク根絶）用バッファ
// ==========================================
// 毎フレームの合体処理で新規配列を生成(new Array や [])せず、
// 同じメモリ番地の配列を使い回すことでガベージコレクションの発生を抑えます。
const compositesToRemove = [];
const compositesToAdd = [];
const tempClampPoint = { x: 0, y: 0 };
const tempVel = { x: 0, y: 0 };
const tempAvgVelA = { x: 0, y: 0 };
const tempAvgVelB = { x: 0, y: 0 };

// 接触即合体を防ぐ「吸い付きの間」ディレイキュー
const pendingMerges = [];

// 同一ゼリーペア別の衝突音クールダウン管理（下敷き小塊の衝突音連打を100%根絶）
const pairCollideSoundTimestamps = new Map();
const PAIR_MAP_PURGE_THRESHOLD = 200;

// 連鎖ピッチ上昇演出用の状態管理
let lastMergeSoundTime = 0;
let currentChainCount = 0;

/**
 * ゼリーの面積に応じた合体前の「吸い付きの間（80〜145ms）」を算出する
 * @param {number} value - 合体元のゼリー数値
 * @returns {number} 吸い付きディレイ時間（ミリ秒）
 */
function calcAreaAnticipationDelayMs(value) {
    const config = JELLY_CONFIG[value] || JELLY_CONFIG[32768] || JELLY_CONFIG[16384] || JELLY_CONFIG[8192];
    const radius = config ? config.radius : 25.5;
    const area = Math.PI * radius * radius;
    const minMs = EFFECTS.MERGE_ANTICIPATION_MIN_MS || EFFECTS.MERGE_BASE_DELAY_MS || 80;
    const maxMs = EFFECTS.MERGE_ANTICIPATION_MAX_MS || 145;
    const areaFactor = EFFECTS.MERGE_AREA_DELAY_FACTOR || 0.011;
    return Math.max(minMs, Math.min(maxMs, Math.round(minMs + area * areaFactor)));
}

/**
 * ゼリーの面積に応じた合体後の保護時間（680〜1200ms：真っ白フラッシュ＆連鎖の間と1対1同期）を算出する
 * @param {number} value - 合体後に生成されたゼリー数値
 * @returns {number} 合体保護時間（ミリ秒）
 */
function calcAreaMergeProtectMs(value) {
    const config = JELLY_CONFIG[value] || JELLY_CONFIG[32768] || JELLY_CONFIG[16384] || JELLY_CONFIG[8192];
    const radius = config ? config.radius : 25.5;
    const area = Math.PI * radius * radius;
    const minMs = EFFECTS.MERGE_PROTECT_MIN_MS || 680;
    const maxMs = EFFECTS.MERGE_PROTECT_MAX_MS || 1200;
    const areaFactor = EFFECTS.MERGE_PROTECT_AREA_FACTOR || 0.023;
    return Math.max(minMs, Math.min(maxMs, Math.round(minMs + area * areaFactor)));
}

/**
 * ソフトボディの全ビーズから現在の平均重心速度を安全に取得する
 * @param {Matter.Composite} comp - 対象のゼリーコンポジット
 * @param {{ x: number, y: number }|null} [out=null] - GC負荷削減用の出力先オブジェクト
 * @returns {{ x: number, y: number }}
 */
function getSoftBodyAverageVelocity(comp, out = null) {
    const target = out || { x: 0, y: 0 };
    if (!comp) {
        target.x = 0;
        target.y = 0;
        return target;
    }
    const particles = comp.particles;
    if (!particles || particles.length === 0) {
        target.x = comp.centroidVel ? (comp.centroidVel.x || 0) : 0;
        target.y = comp.centroidVel ? (comp.centroidVel.y || 0) : 0;
        return target;
    }

    let sumVx = 0;
    let sumVy = 0;
    const n = particles.length;
    for (let i = 0; i < n; i++) {
        sumVx += particles[i].velocity.x;
        sumVy += particles[i].velocity.y;
    }
    target.x = sumVx / n;
    target.y = sumVy / n;
    return target;
}

/**
 * 吸い付きディレイ中の合体ペアに対して、全体の並進運動量を保存したまま
 * 離反相対速度を対称吸収し、互いに穏やかに引き寄せる（反発分離ワープ防止）
 * @param {Matter.Composite} compA
 * @param {Matter.Composite} compB
 * @param {boolean} isFloatingMerge - バー上合体かどうか
 */
function applyMergeAttraction(compA, compB, isFloatingMerge) {
    if (!compA || !compB || !compA.particles || !compB.particles) return;

    const posA = getSoftBodyCentroid(compA);
    const posB = getSoftBodyCentroid(compB);
    if (!posA || !posB) return;

    const dx = posB.x - posA.x;
    const dy = isFloatingMerge ? 0 : (posB.y - posA.y);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.5) return;

    const ux = dx / dist;
    const uy = dy / dist;

    const velA = getSoftBodyAverageVelocity(compA, tempAvgVelA);
    const velB = getSoftBodyAverageVelocity(compB, tempAvgVelB);

    // 2体が反発して離れようとしている法線相対速度成分のみ対称に吸収（全体並進運動量は完全保存）
    const relApproach = (velA.x - velB.x) * ux + (velA.y - velB.y) * uy;
    let dv = Math.min(0.14, dist * 0.006);
    if (relApproach < 0) {
        dv += (-relApproach) * 0.25;
    }

    const addX = ux * dv;
    const addY = uy * dv;
    const ptsA = compA.particles;
    const ptsB = compB.particles;

    for (let i = 0; i < ptsA.length; i++) {
        const p = ptsA[i];
        tempVel.x = p.velocity.x + addX;
        tempVel.y = p.velocity.y + addY;
        Body.setVelocity(p, tempVel);
    }
    for (let i = 0; i < ptsB.length; i++) {
        const p = ptsB[i];
        tempVel.x = p.velocity.x - addX;
        tempVel.y = p.velocity.y - addY;
        Body.setVelocity(p, tempVel);
    }
}

/**
 * 指定コンポジットの全ビーズを (shiftX, shiftY) だけ容器内壁・45度スロープ内クランプ付きで安全シフトし、
 * centroid および aabb を即同期して重心の実際の移動距離（px）を返す
 * @param {Matter.Composite} comp
 * @param {number} shiftX
 * @param {number} shiftY
 * @returns {number} 実際の重心移動距離（px）
 */
function shiftCompositeClamped(comp, shiftX, shiftY) {
    const pts = comp.particles;
    const n = pts.length;
    const pRadius = comp.particleRadius || 4;
    let prevSumX = 0;
    let prevSumY = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < n; i++) {
        const p = pts[i];
        prevSumX += p.position.x;
        prevSumY += p.position.y;
        const clamped = clampPointToContainer(
            p.position.x + shiftX,
            p.position.y + shiftY,
            pRadius,
            tempClampPoint
        );
        Body.setPosition(p, clamped);
        sumX += clamped.x;
        sumY += clamped.y;
        if (clamped.x < minX) minX = clamped.x;
        if (clamped.x > maxX) maxX = clamped.x;
        if (clamped.y < minY) minY = clamped.y;
        if (clamped.y > maxY) maxY = clamped.y;
    }

    const oldCx = prevSumX / n;
    const oldCy = prevSumY / n;
    const newCx = sumX / n;
    const newCy = sumY / n;

    if (comp.centroid) {
        comp.centroid.x = newCx;
        comp.centroid.y = newCy;
    } else {
        comp.centroid = { x: newCx, y: newCy };
    }
    if (comp.aabb) {
        comp.aabb.minX = minX;
        comp.aabb.maxX = maxX;
        comp.aabb.minY = minY;
        comp.aabb.maxY = maxY;
    } else {
        comp.aabb = { minX, maxX, minY, maxY };
    }

    return Math.hypot(newCx - oldCx, newCy - oldCy);
}

/**
 * 下段合体で新ゼリーを生成する直前に、縮小スポーン輪郭内に飲み込まれる恐れのある非合体中小〜中塊のみを
 * 容器内壁クランプ＋壁際逃げ道フォールバック（中央上方向退避）付きで安全に押し分ける
 * @param {Matter.World} world
 * @param {number} spawnX
 * @param {number} spawnY
 * @param {number} spawnRadius
 */
function clearMergeSpawnOverlap(world, spawnX, spawnY, spawnRadius) {
    if (!world || spawnRadius <= 0) return;
    const composites = world.composites || [];
    const maxTargetRadius = spawnRadius * 0.85;
    const maxShiftLimit = spawnRadius * 0.85;

    for (let i = 0; i < composites.length; i++) {
        const other = composites[i];
        if (!other ||
            other.label !== 'jelly_composite' ||
            other.isFloating ||
            other.isBarHopping ||
            other.isMerging ||
            !other.particles ||
            other.particles.length === 0) {
            continue;
        }

        const otherRadius = other.targetRadius || 25.5;
        // 中空リング内に飲み込まれる恐れのある小〜中塊のみを対象とし、隣接大塊の連鎖ワープを防止
        if (otherRadius >= maxTargetRadius) continue;

        const otherPos = getSoftBodyCentroid(other);
        if (!otherPos) continue;

        const dx = otherPos.x - spawnX;
        const dy = otherPos.y - spawnY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const clearDist = spawnRadius + otherRadius * 0.45;

        if (dist >= clearDist) continue;

        const neededShift = Math.min(maxShiftLimit, (clearDist - dist) + 4);
        if (neededShift <= 0.5) continue;

        let ux = 0;
        let uy = -1;
        if (dist > 0.001) {
            ux = dx / dist;
            uy = dy / dist;
        } else {
            const toCenterX = Math.max(-1, Math.min(1, ((GAME_WIDTH * 0.5) - otherPos.x) / 100));
            const fallbackLen = Math.hypot(toCenterX, -1);
            ux = toCenterX / fallbackLen;
            uy = -1 / fallbackLen;
        }

        const movedDist = shiftCompositeClamped(other, ux * neededShift, uy * neededShift);

        // 壁際・底面際・45度スロープ際で外側方向が塞がれていた場合は、中央上方向へ代替退避する
        if (movedDist < neededShift * 0.4) {
            const curPos = other.centroid || otherPos;
            const toCenterX = Math.max(-1, Math.min(1, ((GAME_WIDTH * 0.5) - curPos.x) / 100));
            const fallbackLen = Math.hypot(toCenterX, -1);
            const fbUx = toCenterX / fallbackLen;
            const fbUy = -1 / fallbackLen;
            const remainShift = Math.max(neededShift * 0.6, neededShift - movedDist);
            shiftCompositeClamped(other, fbUx * remainShift, fbUy * remainShift);
        }
    }
}

/**
 * ペア別衝突音クールダウンMapのエントリ数が閾値を超えた際、期限切れキーを自動パージする
 * @param {number} now - 現在時刻（ミリ秒）
 * @param {number} cooldownMs - クールダウン時間（ミリ秒）
 */
function purgeExpiredPairCooldowns(now, cooldownMs) {
    if (pairCollideSoundTimestamps.size <= PAIR_MAP_PURGE_THRESHOLD) return;
    for (const [key, lastTime] of pairCollideSoundTimestamps) {
        if (now - lastTime >= cooldownMs) {
            pairCollideSoundTimestamps.delete(key);
        }
    }
}

/**
 * リトライ時に合体待機・削除・追加キュー、ペア別衝突音マップ、および連鎖状態を初期化する（ゴーストゼリー防止）
 */
export function resetMergeQueues() {
    pendingMerges.length = 0;
    compositesToRemove.length = 0;
    compositesToAdd.length = 0;
    pairCollideSoundTimestamps.clear();
    lastMergeSoundTime = 0;
    currentChainCount = 0;
}

/**
 * 衝突イベントを処理し、落下中ゼリーの初着地検知、同数字ソフトボディの合体キュー登録（吸い付き音含む）、
 * および重心法線接近速度ベースの衝突音・静的壁バウンド音判定を行う
 * ※本家準拠スコアの確定加算は handleMerges() の合体実行タイミングへ統一（互換のため常に 0 を返却）
 * @param {Object} event - Matter.js の collisionStart / collisionActive イベントオブジェクト
 * @param {boolean} allowCollideSound - 衝突音を鳴らすかどうか（collisionActive 呼び出し時は false 指定可）
 * @returns {number} 常に 0（確定獲得スコアは handleMerges() 戻り値で返却）
 */
export function handleCollisions(event, allowCollideSound = true) {
    const pairs = event.pairs;
    const now = Date.now();
    const minCollideSpeed = (PHYSICS.COLLIDE_SOUND_MIN_SPEED !== undefined) ? PHYSICS.COLLIDE_SOUND_MIN_SPEED : 0.90;
    const maxCollideSpeed = PHYSICS.COLLIDE_SOUND_MAX_SPEED || 3.0;
    const pairCooldownMs = PHYSICS.COLLIDE_SOUND_PAIR_COOLDOWN_MS || 650;
    const maxBarMergeValue = FLOAT_BAR.BAR_MERGE_MAX_VALUE || 512;
    const barAttachMaxY = (FLOAT_BAR.HOP_RECATCH_Y_MAX || (FLOAT_BAR.Y + 30)) + 16;

    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const bodyA = pair.bodyA;
        const bodyB = pair.bodyB;
        let mergeTriggered = false;

        // --- 0. 落下中ゼリーの厳密初着地検知（collisionStart / collisionActive 双方で漏れなく判定） ---
        // ①着地済み下段ゼリー（otherComp.hasLanded === true）との接触
        // ②床または底面45度スロープ（floor / corner_slope_left / corner_slope_right）との接触（左右壁バンクショット除外）
        if (bodyA.label === 'jelly_particle' &&
            bodyB.label === 'jelly_particle' &&
            bodyA.jellyId !== bodyB.jellyId) {
            const compA = bodyA.parentComposite;
            const compB = bodyB.parentComposite;
            if (compA && compB) {
                const aLanded = Boolean(compA.hasLanded);
                const bLanded = Boolean(compB.hasLanded);
                if (!aLanded && bLanded && !compA.isFloating && !compA.isBarHopping) {
                    compA.hasLanded = true;
                    compA.landedAt = now;
                }
                if (!bLanded && aLanded && !compB.isFloating && !compB.isBarHopping) {
                    compB.hasLanded = true;
                    compB.landedAt = now;
                }
            }
        } else {
            let fallingBody = null;
            let staticBody = null;
            if (bodyA.label === 'jelly_particle' && bodyB.isStatic === true) {
                fallingBody = bodyA;
                staticBody = bodyB;
            } else if (bodyB.label === 'jelly_particle' && bodyA.isStatic === true) {
                fallingBody = bodyB;
                staticBody = bodyA;
            }

            if (fallingBody && staticBody &&
                (staticBody.label === 'floor' ||
                 staticBody.label === 'corner_slope_left' ||
                 staticBody.label === 'corner_slope_right')) {
                const comp = fallingBody.parentComposite;
                if (comp && !comp.isFloating && !comp.isBarHopping && !comp.hasLanded) {
                    comp.hasLanded = true;
                    comp.landedAt = now;
                }
            }
        }

        // --- 1. 合体判定（先に評価し、合体成立ペアでは通常衝突音をスキップして吸い付き音へ一本化） ---
        // 双方ともにゼリーの構成要素であるか確認
        if (bodyA.jellyId && bodyB.jellyId) {
            // 異なるゼリー同士であり、かつ数字が同じである場合
            if (bodyA.jellyId !== bodyB.jellyId && bodyA.jellyValue === bodyB.jellyValue) {
                const compA = bodyA.parentComposite;
                const compB = bodyB.parentComposite;

                // 双方のソフトボディが有効かつ合体処理中(isMerging)ではない場合
                if (compA && compB && !compA.isMerging && !compB.isMerging) {
                    // 合体直後の真っ白フラッシュ＆面積比例保護期間中でない場合のみ合体成立（保護中は通常衝突音へフォールスルー）
                    const isProtected = Boolean(
                        (compA.mergeProtectedUntil && now < compA.mergeProtectedUntil) ||
                        (compB.mergeProtectedUntil && now < compB.mergeProtectedUntil)
                    );

                    if (!isProtected) {
                        mergeTriggered = true;

                        // GRAVITY規格: 同一フレーム内での多重発火の即時遮断（排他ロック）
                        compA.isMerging = true;
                        compB.isMerging = true;

                        // 合体前の「吸い付きの間（80〜145ms）」用メタデータを相互付与
                        // overlap_solver.js がこのペア同士の排斥を除外し、render.js が予兆発光を描画する
                        const delayMs = calcAreaAnticipationDelayMs(bodyA.jellyValue);
                        const executeTime = now + delayMs;
                        compA.mergePartnerId = compB.jellyId;
                        compB.mergePartnerId = compA.jellyId;
                        compA.mergePreGlowStart = now;
                        compB.mergePreGlowStart = now;
                        compA.mergePreGlowUntil = executeTime;
                        compB.mergePreGlowUntil = executeTime;

                        // 合体成立ペア専用の極小水膜結合音（「ちゅぷっ」）を再生
                        playSoundMergeAnticipate(bodyA.jellyValue);

                        // 中空ビーズリングの現在重心を基準に中間点を算出
                        const posA = getSoftBodyCentroid(compA) || bodyA.position;
                        const posB = getSoftBodyCentroid(compB) || bodyB.position;
                        const midX = (posA.x + posB.x) / 2;
                        const rawMidY = (posA.y + posB.y) / 2;
                        const newValue = bodyA.jellyValue * 2;

                        // バー上合体の安全条件化（下段定着済み巨大ゼリーの上段ワープ吸い上げ防止 ＆ 横ショット・ホップ着地合体対応）
                        // 1. 双方とも上段（浮遊中またはホップ中）かつ上限サイズ以下 → 確実に上段バーへ留める
                        // 2. 片方が上段かつ双方未着地（横ショットバー上合体等）で上限サイズ以下・バー高度付近にある場合のみ上段バーへ留める
                        const aOnBar = Boolean(compA.isFloating || compA.isBarHopping);
                        const bOnBar = Boolean(compB.isFloating || compB.isBarHopping);
                        const neitherLanded = !compA.hasLanded && !compB.hasLanded;
                        const isWithinBarLimit = newValue <= maxBarMergeValue;
                        const isFloatingMerge = isWithinBarLimit && (
                            (aOnBar && bOnBar) ||
                            ((aOnBar || bOnBar) && neitherLanded && rawMidY <= barAttachMaxY)
                        );

                        const midY = isFloatingMerge ? FLOAT_BAR.Y : rawMidY;

                        // 即時合体させず、面積に応じた「吸い付きの間」ディレイキューに保留する
                        pendingMerges.push({
                            compA: compA,
                            compB: compB,
                            x: midX,
                            y: midY,
                            value: newValue,
                            isFloating: isFloatingMerge,
                            executeTime: executeTime
                        });
                    }
                }
            }
        }

        // --- 2. 衝突音の判定と再生（合体成立ペアではスキップして 0ms 二重濁りを根絶） ---
        if (allowCollideSound && !mergeTriggered) {
            if (bodyA.label === 'jelly_particle' &&
                bodyB.label === 'jelly_particle' &&
                bodyA.jellyId !== bodyB.jellyId) {
                // (A) ゼリー同士の衝突音（重心法線接近速度判定 ＋ 同一ゼリーペア別 650ms クールダウン）
                const compA = bodyA.parentComposite;
                const compB = bodyB.parentComposite;

                if (compA && compB && !compA.isMerging && !compB.isMerging) {
                    const posA = compA.centroid || getSoftBodyCentroid(compA) || bodyA.position;
                    const posB = compB.centroid || getSoftBodyCentroid(compB) || bodyB.position;
                    const velA = compA.centroidVel;
                    const velB = compB.centroidVel;

                    if (posA && posB && velA && velB) {
                        const dx = posB.x - posA.x;
                        const dy = posB.y - posA.y;
                        const dist = Math.sqrt(dx * dx + dy * dy);

                        if (dist > 0.001) {
                            // A→B の単位法線方向への重心接近速度のみを評価（離反・すれ違い・下敷き微振動は無音）
                            const ux = dx / dist;
                            const uy = dy / dist;
                            const approachSpeed = (velA.x - velB.x) * ux + (velA.y - velB.y) * uy;

                            if (approachSpeed > minCollideSpeed) {
                                const idA = bodyA.jellyId;
                                const idB = bodyB.jellyId;
                                const pairKey = (idA < idB) ? `${idA}|${idB}` : `${idB}|${idA}`;
                                const lastPairTime = pairCollideSoundTimestamps.get(pairKey);

                                if (lastPairTime === undefined || (now - lastPairTime) >= pairCooldownMs) {
                                    pairCollideSoundTimestamps.set(pairKey, now);
                                    purgeExpiredPairCooldowns(now, pairCooldownMs);

                                    const intensity = Math.min(1.0, approachSpeed / maxCollideSpeed);
                                    const valA = bodyA.jellyValue || 1;
                                    const valB = bodyB.jellyValue || 1;
                                    const combinedSizeValue = Math.sqrt(valA * valB);
                                    playSoundCollide(intensity, combinedSizeValue);
                                }
                            }
                        }
                    }
                }
            } else {
                // (B) 静的壁・床・スロープとの高速衝突時バウンド音（実効法線接近速度 >= 2.4 px/frame・壁沿い縦滑落の誤爆ゼロ）
                let jellyBody = null;
                if (bodyA.label === 'jelly_particle' && bodyB.isStatic === true) {
                    jellyBody = bodyA;
                } else if (bodyB.label === 'jelly_particle' && bodyA.isStatic === true) {
                    jellyBody = bodyB;
                }

                if (jellyBody && jellyBody.jellyId) {
                    const comp = jellyBody.parentComposite;
                    if (comp && !comp.isFloating && !comp.isMerging) {
                        const normal = pair.collision ? pair.collision.normal : null;
                        const vel = comp.centroidVel || jellyBody.velocity;
                        if (normal && vel) {
                            const vn = Math.abs(vel.x * normal.x + vel.y * normal.y);
                            if (vn >= 2.4) {
                                const intensity = Math.max(0.1, Math.min(1.0, (vn - 1.4) / 6.0) * 0.60);
                                const pairKey = `${jellyBody.jellyId}|WALL`;
                                const lastPairTime = pairCollideSoundTimestamps.get(pairKey);
                                if (lastPairTime === undefined || (now - lastPairTime) >= pairCooldownMs) {
                                    pairCollideSoundTimestamps.set(pairKey, now);
                                    purgeExpiredPairCooldowns(now, pairCooldownMs);
                                    playSoundCollide(intensity, jellyBody.jellyValue || 1);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return 0;
}

/**
 * 物理演算の更新(afterUpdate)後に、吸い付きディレイ中の引き寄せおよび安全にソフトボディの追加・削除を行い、
 * このフレームで実際に合体が確定した本家準拠スコア（未合体Soboの初参加分のみ）を返す
 * @param {Matter.World} world - 現在の物理世界
 * @returns {number} このフレームで合体確定により獲得したスコア
 */
export function handleMerges(world) {
    let earnedScore = 0;
    const now = Date.now();
    const maxVx = PHYSICS.MAX_PARTICLE_VX || 10.5;
    const maxVy = PHYSICS.MAX_PARTICLE_VY || 12.0;

    // 1. 「吸い付きの間」ディレイキューをチェックし、待機中は穏やかに引き寄せ、猶予経過で実行キューへ移す
    for (let i = pendingMerges.length - 1; i >= 0; i--) {
        const pm = pendingMerges[i];
        const executeTime = Math.max(
            pm.executeTime,
            (pm.compA && pm.compA.mergePreGlowUntil) || 0,
            (pm.compB && pm.compB.mergePreGlowUntil) || 0
        );
        if (now >= executeTime) {
            // 吸い付き時間中の移動・押し合いにも追従できるよう、実行直前の最新重心から生成座標を再計算
            const latestA = getSoftBodyCentroid(pm.compA);
            const latestB = getSoftBodyCentroid(pm.compB);

            // 親2体の平均運動量を継承（空中・押し込み合体時のピタッと停止を解消）
            const velA = getSoftBodyAverageVelocity(pm.compA, tempAvgVelA);
            const velB = getSoftBodyAverageVelocity(pm.compB, tempAvgVelB);

            let finalX = (latestA && latestB) ? ((latestA.x + latestB.x) / 2) : pm.x;
            let finalY = pm.isFloating
                ? FLOAT_BAR.Y
                : ((latestA && latestB) ? ((latestA.y + latestB.y) / 2) : pm.y);

            // 吸い付き中に大塊の割り込み等で親2体が過度に引き離された場合は、
            // 単純中点（割り込み大塊の中心）を避け、速度の小さい安定側の親重心へ生成位置を補正する
            if (!pm.isFloating && latestA && latestB) {
                const rA = pm.compA.targetRadius || 25.5;
                const rB = pm.compB.targetRadius || 25.5;
                const sepDist = Math.hypot(latestB.x - latestA.x, latestB.y - latestA.y);
                if (sepDist > (rA + rB) * 1.35) {
                    const spdSqA = velA.x * velA.x + velA.y * velA.y;
                    const spdSqB = velB.x * velB.x + velB.y * velB.y;
                    if (spdSqA <= spdSqB) {
                        finalX = latestA.x;
                        finalY = latestA.y;
                    } else {
                        finalX = latestB.x;
                        finalY = latestB.y;
                    }
                }
            }

            const avgVx = (velA.x + velB.x) * 0.5;
            const avgVy = (velA.y + velB.y) * 0.5;
            let inheritedVelocity;

            if (pm.isFloating) {
                inheritedVelocity = {
                    x: Math.max(-2.5, Math.min(2.5, avgVx * 0.75)),
                    y: 0
                };
            } else {
                inheritedVelocity = {
                    x: Math.max(-maxVx, Math.min(maxVx, avgVx * 0.85)),
                    y: Math.max(-maxVy, Math.min(maxVy, avgVy * 0.85))
                };
            }

            // 下段合体時に親2体がともに未着地（空中合体）なら startLanded = false を継承して自然な落下速度を維持
            const startLanded = pm.isFloating ? false : Boolean(pm.compA.hasLanded || pm.compB.hasLanded);

            // 【本家完全準拠スコア計算】合体実行確定タイミングで未合体（hasMerged === false）分のみ計上
            let mergeScore = 0;
            if (!pm.compA.hasMerged) {
                mergeScore += pm.compA.jellyValue;
            }
            if (!pm.compB.hasMerged) {
                mergeScore += pm.compB.jellyValue;
            }

            compositesToRemove.push(pm.compA, pm.compB);
            compositesToAdd.push({
                x: finalX,
                y: finalY,
                value: pm.value,
                isFloating: pm.isFloating,
                startLanded: startLanded,
                earnedScore: mergeScore,
                initialVelocity: inheritedVelocity
            });
            pendingMerges.splice(i, 1);
        } else {
            // 吸い付きディレイ中の反発分離ワープを抑える穏やかな対称引き寄せ
            applyMergeAttraction(pm.compA, pm.compB, pm.isFloating);
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
        const chainWindowMs = SCORE.CHAIN_WINDOW_MS || 2100;
        const growStartScale = EFFECTS.MERGE_GROW_START_SCALE || 0.78;
        const baseImpulse = PHYSICS.MERGE_RADIAL_IMPULSE || 0.86;

        // 一体外枠フレーム（FRAME_WIDTH / TOP_BAR_HEIGHT）の内壁基準クランプ定数
        const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
        const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;
        const safeBarPadX = Math.max(frameW + 4, FLOAT_BAR.PADDING_X || 26);

        for (let i = 0; i < compositesToAdd.length; i++) {
            const data = compositesToAdd[i];
            const val = data.value;
            const newConfig = JELLY_CONFIG[val] || JELLY_CONFIG[32768] || JELLY_CONFIG[16384] || JELLY_CONFIG[8192];
            const newRadius = newConfig ? newConfig.radius : 25.5;

            // 生成座標の内壁基準安全クランプ（上段は横長カプセル実幅基準、下段は縮小スポーン半径基準）
            let spawnX = data.x;
            let spawnY = data.y;
            if (data.isFloating) {
                const capExtents = getCapsuleHalfExtentsForValue(val);
                const capsuleHalfW = capExtents ? capExtents.halfWidth : newRadius;
                const minX = safeBarPadX + capsuleHalfW;
                const maxX = GAME_WIDTH - safeBarPadX - capsuleHalfW;
                spawnX = (minX <= maxX) ? Math.max(minX, Math.min(maxX, spawnX)) : (GAME_WIDTH / 2);
                spawnY = FLOAT_BAR.Y;
            } else {
                const spawnRadius = newRadius * growStartScale;
                const minX = frameW + spawnRadius + 4;
                const maxX = GAME_WIDTH - frameW - spawnRadius - 4;
                const minY = topBarH + spawnRadius + 4;
                const maxY = GAME_HEIGHT - frameW - spawnRadius - 4;
                spawnX = (minX <= maxX) ? Math.max(minX, Math.min(maxX, spawnX)) : (GAME_WIDTH / 2);
                spawnY = (minY <= maxY) ? Math.max(minY, Math.min(maxY, spawnY)) : (GAME_HEIGHT / 2);

                // 下段新ゼリー生成直前に、中空リング内に飲み込まれる恐れのある小〜中塊を外側へ安全退避させる
                clearMergeSpawnOverlap(world, spawnX, spawnY, spawnRadius);
            }

            // 新しい一段階大きな中空ビーズリングを「親2体の運動量継承 ＋ 縮小スポーン（0.78倍）→ Ease-Out-Back 膨張成長」で生成
            // バー上合体の場合は isFloating = true により横長カプセル形状で安全生成、hasMerged = true を付与
            const newJellyComposite = createSoftBodyJelly(
                spawnX,
                spawnY,
                val,
                data.initialVelocity || null,
                data.isFloating,
                true,
                growStartScale,
                data.startLanded
            );

            // 本家準拠：合体保護時間（680〜1200ms）と真っ白フラッシュ（mergeFlashStart / mergeFlashUntil）を1対1完全同期
            // 真っ白から本色へ戻りきった瞬間に次の連鎖合体が解禁される
            const protectionMs = calcAreaMergeProtectMs(val);
            newJellyComposite.mergeProtectedUntil = now + protectionMs;
            newJellyComposite.mergeFlashStart = now;
            newJellyComposite.mergeFlashUntil = now + protectionMs;

            Composite.add(world, newJellyComposite);
            earnedScore += data.earnedScore || 0;

            // サウンド連携: 連鎖ウィンドウ内であれば連鎖カウントを進めて純正ペンタトニック上昇＋サイズ連動ボディを再生
            if (now - lastMergeSoundTime <= chainWindowMs) {
                currentChainCount++;
            } else {
                currentChainCount = 0;
            }
            lastMergeSoundTime = now;
            playSoundMerge(currentChainCount, val);

            // ==========================================
            // フィールド内合体時の連鎖膨張インパルス（world.composites 直接走査・X/Y独立最大速度上限統一）
            // ==========================================
            // バー上での事前合体時は待機列を吹き飛ばさないよう衝撃波をスキップする
            if (!data.isFloating) {
                const effectRadius = newRadius * 2.5; // 影響範囲（自身のサイズの2.5倍程度）
                const composites = world.composites || [];

                for (let c = 0; c < composites.length; c++) {
                    const otherComp = composites[c];
                    // フィールド内の他ゼリーのみ対象（バー上・ホップ中・自分自身はコンポジット単位で高速除外）
                    if (!otherComp ||
                        otherComp.label !== 'jelly_composite' ||
                        otherComp.jellyId === newJellyComposite.jellyId ||
                        otherComp.isFloating ||
                        otherComp.isBarHopping ||
                        !otherComp.particles) {
                        continue;
                    }

                    const otherParticles = otherComp.particles;
                    for (let j = 0; j < otherParticles.length; j++) {
                        const body = otherParticles[j];
                        const dx = body.position.x - spawnX;
                        const dy = body.position.y - spawnY;
                        const dist = Math.sqrt(dx * dx + dy * dy);

                        // 影響範囲内にいる他のゼリーに対して外向きの速度インパルスを適用
                        if (dist > 0.001 && dist < effectRadius) {
                            // 近いほど強く、遠いほど弱い押し出しになるよう線形減衰させる
                            const impulseMagnitude = baseImpulse * (1 - (dist / effectRadius));
                            tempVel.x = Math.max(-maxVx, Math.min(maxVx, body.velocity.x + (dx / dist) * impulseMagnitude));
                            tempVel.y = Math.max(-maxVy, Math.min(maxVy, body.velocity.y + (dy / dist) * impulseMagnitude));

                            Body.setVelocity(body, tempVel);
                        }
                    }
                }
            }
        }
        compositesToAdd.length = 0;
    }

    return earnedScore;
}