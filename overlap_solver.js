/**
 * overlap_solver.js
 * @version v8.5 (Batched Bead Position Push, Zero-Alloc Vector Reuse & Redundant Guard Removal - Phase 10)
 * @changes
 *   - resolvePolygonIntrusion() の通常部分侵入時における対称分散排斥（本体 64%＋両隣各 18%、および相手エッジ両端 70%＋外側隣接 30%）で同一ビーズへ重複発生していた Body.setPosition を事前確保バッファへ蓄積し、1ペア処理につきビーズ 1 個あたり最大 1 回へ集約
 *   - applyClampedPush() / absorbEdgeApproachVelocity() / resolvePolygonIntrusion() 内の Body.setPosition / Body.setVelocity に渡す一時 { x, y } リテラルを事前確保オブジェクト（tempClampPoint / tempVel）へ置換し、毎サブステップの GC 負荷を削減
 *   - isPointInsidePolygon() 内の数学的に発生しない冗長なゼロ除算ガード（(yj - yi) || 1e-9）を削除
 * 
 * ソフトボディ間の「非侵入（Anti-Overlap）排斥ソルバー」および共通幾何判定を提供するモジュール
 * 
 * 広域AABB高速絞り込み ＋ Point-in-Polygon 包含判定 ＋ 内包時の統一方向脱出（Composite Ejection）および
 * 双方最近傍エッジ外向き対称分散排斥により、中空ビーズリング同士のめり込み・重なり固定および局所的な突起奇形を物理的に解消します。
 */

import Matter from 'https://esm.sh/matter-js';
import { PHYSICS } from '/sobosuba/constants.js?v=7';
import { clampPointToContainer } from '/sobosuba/physics.js?v=7';

const Body = Matter.Body;

// ゼロアロケーション（毎サブステップGC負荷削減）用の作業バッファ
const tempClampPoint = { x: 0, y: 0 };
const tempWallCheckPoint = { x: 0, y: 0 };
const tempVel = { x: 0, y: 0 };
let insideFlagsBuffer = new Uint8Array(64);
let pushAccumAX = new Float64Array(64);
let pushAccumAY = new Float64Array(64);
let pushAccumBX = new Float64Array(64);
let pushAccumBY = new Float64Array(64);

/**
 * 1パス内包判定フラグバッファの容量が不足する場合のみ拡張する
 * @param {number} requiredCount
 */
function ensureInsideFlagsCapacity(requiredCount) {
    if (insideFlagsBuffer.length < requiredCount) {
        insideFlagsBuffer = new Uint8Array(requiredCount);
    }
}

/**
 * 通常部分侵入時の対称分散排斥変位を蓄積する事前確保バッファの容量を確保する
 * @param {number} requiredA
 * @param {number} requiredB
 */
function ensurePushAccumCapacity(requiredA, requiredB) {
    if (pushAccumAX.length < requiredA) {
        pushAccumAX = new Float64Array(requiredA);
        pushAccumAY = new Float64Array(requiredA);
    }
    if (pushAccumBX.length < requiredB) {
        pushAccumBX = new Float64Array(requiredB);
        pushAccumBY = new Float64Array(requiredB);
    }
}

/**
 * 点 (px, py) が多角形（外周ビーズ群または外縁座標バッファ）の内部にあるか Ray-Casting で判定する
 * softbody.js / overlap_solver.js の Matter.Body 配列と、render.js の {x, y} 配列の双方で共有利用可能
 * @param {number} px - 判定対象点のX座標
 * @param {number} py - 判定対象点のY座標
 * @param {Array<Matter.Body|{x: number, y: number}>} points - 頂点配列
 * @param {number} [count] - 有効頂点数（事前確保バッファ利用時に指定、省略時は points.length）
 * @returns {boolean} 多角形内部にある場合は true
 */
export function isPointInsidePolygon(px, py, points, count) {
    if (!points) return false;
    const m = (count !== undefined && count !== null) ? count : points.length;
    if (m < 3) return false;

    const first = points[0];
    if (!first) return false;

    let inside = false;

    // ループ外でデータ形式を1回だけ判定し、毎サブステップ／毎フレームの分岐負荷を最小化
    if (first.position) {
        for (let k = 0, l = m - 1; k < m; l = k++) {
            const pk = points[k].position;
            const pl = points[l].position;
            const xi = pk.x;
            const yi = pk.y;
            const xj = pl.x;
            const yj = pl.y;

            if (((yi > py) !== (yj > py)) &&
                (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
    } else {
        for (let k = 0, l = m - 1; k < m; l = k++) {
            const pk = points[k];
            const pl = points[l];
            const xi = pk.x;
            const yi = pk.y;
            const xj = pl.x;
            const yj = pl.y;

            if (((yi > py) !== (yj > py)) &&
                (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
    }

    return inside;
}

/**
 * 2つのゼリーが「合体ディレイ中（吸い付きの間）」の同一合体ペアかどうかを判定する
 * @param {Matter.Composite} compA
 * @param {Matter.Composite} compB
 * @returns {boolean}
 */
function isMergingPair(compA, compB) {
    if (!compA.isMerging || !compB.isMerging) return false;

    // 明示的なパートナーIDが付与されている場合は厳密一致で判定
    if (compA.mergePartnerId || compB.mergePartnerId) {
        return compA.mergePartnerId === compB.jellyId || compB.mergePartnerId === compA.jellyId;
    }

    // パートナーID未設定時のフォールバック：合体待機中の同数字ペアとして扱う
    return compA.jellyValue === compB.jellyValue;
}

/**
 * 指定ビーズへ指定量の位置補正を安全（内壁・45度スロープ内クランプ付き）に適用する
 * @param {Matter.Body} body - 対象ビーズ
 * @param {number} dx - X方向移動量
 * @param {number} dy - Y方向移動量
 * @param {number} margin - 内壁・スロープからの内側マージン（ビーズ半径）
 */
function applyClampedPush(body, dx, dy, margin) {
    if (!body) return;
    const nextPt = clampPointToContainer(
        body.position.x + dx,
        body.position.y + dy,
        margin,
        tempClampPoint
    );
    Body.setPosition(body, nextPt);
}

/**
 * 統一方向脱出直後にコンポジットの centroid および aabb をインプレース再同期する
 * @param {Matter.Composite} comp
 */
function syncCompositeCentroidAndAABB(comp) {
    if (!comp || !comp.particles || comp.particles.length === 0) return;
    const pts = comp.particles;
    const n = pts.length;
    let sumX = 0;
    let sumY = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < n; i++) {
        const pos = pts[i].position;
        sumX += pos.x;
        sumY += pos.y;
        if (pos.x < minX) minX = pos.x;
        if (pos.x > maxX) maxX = pos.x;
        if (pos.y < minY) minY = pos.y;
        if (pos.y > maxY) maxY = pos.y;
    }

    if (comp.centroid) {
        comp.centroid.x = sumX / n;
        comp.centroid.y = sumY / n;
    }
    if (comp.aabb) {
        comp.aabb.minX = minX;
        comp.aabb.maxX = maxX;
        comp.aabb.minY = minY;
        comp.aabb.maxY = maxY;
    }
}

/**
 * 相手エッジ側ビーズの衝突法線方向（侵入ビーズへ向かう接近成分）を吸収してジッターを遮断する
 * @param {Matter.Body} body - 相手エッジ側ビーズ
 * @param {number} ux - 侵入ビーズ側の脱出法線X
 * @param {number} uy - 侵入ビーズ側の脱出法線Y
 * @param {number} absorbRatio - 吸収比率（0.0〜1.0）
 */
function absorbEdgeApproachVelocity(body, ux, uy, absorbRatio) {
    if (!body || absorbRatio <= 0.001) return;
    // エッジ側ビーズが脱出法線方向（侵入ビーズ側）へ動いている成分が接近速度
    const velDotB = body.velocity.x * ux + body.velocity.y * uy;
    if (velDotB > 0) {
        tempVel.x = body.velocity.x - ux * velDotB * absorbRatio;
        tempVel.y = body.velocity.y - uy * velDotB * absorbRatio;
        Body.setVelocity(body, tempVel);
    }
}

/**
 * 侵入したビーズ（ゼリーA側）を相手ゼリーBの最近傍エッジ外側へ対称分散（本体64%＋両隣各18%）で押し戻し、
 * 相手側のエッジ2点およびその外側隣接2ビーズへ反作用を滑らかに分散させる。
 * ゼリーAがゼリーBの内部空洞へ深く内包された場合は、壁・床・45度スロープ塞がり回避ペナルティ付きの
 * 統一方向脱出（Composite Ejection）で一斉に外へ吐き出して綱引きロックを根絶する。
 * @param {Matter.Composite} compA - 侵入側ゼリー
 * @param {Matter.Composite} compB - 侵入された側ゼリー
 * @param {number} stiffness - 排斥強度
 * @param {number} maxPush - 1サブステップあたりの最大押し出し量（px）
 * @param {number} slop - 下敷きジッターを遮断する微小侵入デッドゾーン（px）
 */
function resolvePolygonIntrusion(compA, compB, stiffness, maxPush, slop) {
    const ptsA = compA.particles;
    const ptsB = compB.particles;
    if (!ptsA || !ptsB) return;

    const nA = ptsA.length;
    const nB = ptsB.length;
    if (nA < 3 || nB < 3) return;

    const rA = compA.particleRadius || 4;
    const rB = compB.particleRadius || 4;
    const aabbB = compB.aabb;
    const centA = compA.centroid;
    const centB = compB.centroid;
    const bothFloating = Boolean(compA.isFloating && compB.isFloating);
    const effectiveSlop = bothFloating ? 0 : slop;
    const sepPad = (rA + rB) * 0.48;

    // 1パス目：全ビーズの包含判定結果と侵入ビーズ数を事前確保バッファへキャッシュ（二重判定を排除）
    ensureInsideFlagsCapacity(nA);
    let insideCount = 0;
    for (let i = 0; i < nA; i++) {
        const pos = ptsA[i].position;
        const px = pos.x;
        const py = pos.y;
        if (aabbB && (px < aabbB.minX || px > aabbB.maxX || py < aabbB.minY || py > aabbB.maxY)) {
            insideFlagsBuffer[i] = 0;
            continue;
        }
        if (isPointInsidePolygon(px, py, ptsB, nB)) {
            insideFlagsBuffer[i] = 1;
            insideCount++;
        } else {
            insideFlagsBuffer[i] = 0;
        }
    }

    if (insideCount === 0) return;

    // ==========================================
    // 内包・深部飲み込み時の「統一方向脱出（Composite Ejection）」
    // ==========================================
    // 上段待機同士は除外し、下段で明らかな内包状態になった場合のみ単一脱出口へ一斉押し出しを行う
    if (!bothFloating && centA) {
        const centroidInside = isPointInsidePolygon(centA.x, centA.y, ptsB, nB);
        const isDeeplyContained =
            (centroidInside && insideCount >= nA * 0.45) ||
            (insideCount >= nA * 0.55);

        if (isDeeplyContained) {
            const wallClearance = rB + rA * 2.2;
            let bestScore = Infinity;
            let bestDistSq = Infinity;
            let bestIdx1 = 0;
            let bestIdx2 = 1;
            let bestT = 0;
            let bestQx = centA.x;
            let bestQy = centA.y;
            let bestEx = 1;
            let bestEy = 0;

            for (let k = 0; k < nB; k++) {
                const nextK = (k + 1) % nB;
                const b1 = ptsB[k].position;
                const b2 = ptsB[nextK].position;

                const ex = b2.x - b1.x;
                const ey = b2.y - b1.y;
                const lenSq = ex * ex + ey * ey;

                let t = 0;
                if (lenSq > 1e-8) {
                    t = ((centA.x - b1.x) * ex + (centA.y - b1.y) * ey) / lenSq;
                    if (t < 0) t = 0;
                    else if (t > 1) t = 1;
                }

                const qx = b1.x + ex * t;
                const qy = b1.y + ey * t;
                const dx = qx - centA.x;
                const dy = qy - centA.y;
                const distSq = dx * dx + dy * dy;

                // 内壁・天井・床・45度スロープで塞がれている辺には距離ペナルティを課し、開けた辺へ脱出させる
                clampPointToContainer(qx, qy, wallClearance, tempWallCheckPoint);
                const isWallBlocked =
                    Math.abs(tempWallCheckPoint.x - qx) > 0.5 ||
                    Math.abs(tempWallCheckPoint.y - qy) > 0.5;
                const score = isWallBlocked ? (distSq + 25000) : distSq;

                if (score < bestScore) {
                    bestScore = score;
                    bestDistSq = distSq;
                    bestIdx1 = k;
                    bestIdx2 = nextK;
                    bestT = t;
                    bestQx = qx;
                    bestQy = qy;
                    bestEx = ex;
                    bestEy = ey;
                }
            }

            const bestDist = Math.sqrt(bestDistSq);
            let ejectUx = 0;
            let ejectUy = -1;

            if (bestDist > 1.0) {
                ejectUx = (bestQx - centA.x) / bestDist;
                ejectUy = (bestQy - centA.y) / bestDist;
            } else {
                // 極近接時は時計回りエッジの幾何学的外向き法線 (ey, -ex) を採用
                const eLen = Math.sqrt(bestEx * bestEx + bestEy * bestEy);
                if (eLen > 1e-6) {
                    ejectUx = bestEy / eLen;
                    ejectUy = -bestEx / eLen;
                }
            }

            const ejectPush = Math.min(maxPush * 1.35, (bestDist + rA + rB) * stiffness);
            if (ejectPush > 0.001) {
                const pushA = ejectPush * 0.72;
                const pushB = ejectPush * 0.28;

                // 内包された compA の全ビーズを単一の脱出方向へ一斉移動 ＆ 逆向き速度を吸収
                for (let i = 0; i < nA; i++) {
                    const p = ptsA[i];
                    applyClampedPush(p, ejectUx * pushA, ejectUy * pushA, rA);
                    const velDotA = p.velocity.x * ejectUx + p.velocity.y * ejectUy;
                    if (velDotA < 0) {
                        tempVel.x = p.velocity.x - ejectUx * velDotA * 0.72;
                        tempVel.y = p.velocity.y - ejectUy * velDotA * 0.72;
                        Body.setVelocity(p, tempVel);
                    }
                }

                // compB の脱出口周辺エッジを反対側へ開いてスムーズに吐き出す
                const w1 = 1 - bestT;
                const w2 = bestT;
                const b1Body = ptsB[bestIdx1];
                const b2Body = ptsB[bestIdx2];

                if (nB >= 4) {
                    const bPrevBody = ptsB[(bestIdx1 - 1 + nB) % nB];
                    const bNextBody = ptsB[(bestIdx2 + 1) % nB];
                    if (w1 > 0.001) {
                        applyClampedPush(b1Body, -ejectUx * pushB * 0.70 * w1, -ejectUy * pushB * 0.70 * w1, rB);
                        applyClampedPush(bPrevBody, -ejectUx * pushB * 0.30 * w1, -ejectUy * pushB * 0.30 * w1, rB);
                        absorbEdgeApproachVelocity(b1Body, ejectUx, ejectUy, 0.55 * w1);
                        absorbEdgeApproachVelocity(bPrevBody, ejectUx, ejectUy, 0.25 * w1);
                    }
                    if (w2 > 0.001) {
                        applyClampedPush(b2Body, -ejectUx * pushB * 0.70 * w2, -ejectUy * pushB * 0.70 * w2, rB);
                        applyClampedPush(bNextBody, -ejectUx * pushB * 0.30 * w2, -ejectUy * pushB * 0.30 * w2, rB);
                        absorbEdgeApproachVelocity(b2Body, ejectUx, ejectUy, 0.55 * w2);
                        absorbEdgeApproachVelocity(bNextBody, ejectUx, ejectUy, 0.25 * w2);
                    }
                } else {
                    if (w1 > 0.001) {
                        applyClampedPush(b1Body, -ejectUx * pushB * w1, -ejectUy * pushB * w1, rB);
                        absorbEdgeApproachVelocity(b1Body, ejectUx, ejectUy, 0.55 * w1);
                    }
                    if (w2 > 0.001) {
                        applyClampedPush(b2Body, -ejectUx * pushB * w2, -ejectUy * pushB * w2, rB);
                        absorbEdgeApproachVelocity(b2Body, ejectUx, ejectUy, 0.55 * w2);
                    }
                }

                // 後続ペア判定で古い座標を参照しないよう centroid / aabb を即同期
                syncCompositeCentroidAndAABB(compA);
                syncCompositeCentroidAndAABB(compB);
            }
            return;
        }
    }

    // ==========================================
    // 通常部分侵入時の対称分散排斥（1パス目のキャッシュを参照 ＆ ビーズ毎 1 回の Body.setPosition へ集約）
    // ==========================================
    ensurePushAccumCapacity(nA, nB);
    pushAccumAX.fill(0, 0, nA);
    pushAccumAY.fill(0, 0, nA);
    pushAccumBX.fill(0, 0, nB);
    pushAccumBY.fill(0, 0, nB);
    let hasAnyPushA = false;
    let hasAnyPushB = false;

    for (let i = 0; i < nA; i++) {
        if (insideFlagsBuffer[i] === 0) continue;

        const p = ptsA[i];
        const px = p.position.x;
        const py = p.position.y;

        // 相手ポリゴンBの全エッジから点Pへの最近傍エッジと射影点を探索
        let bestDistSq = Infinity;
        let bestIdx1 = 0;
        let bestIdx2 = 1;
        let bestT = 0;
        let bestQx = px;
        let bestQy = py;

        for (let k = 0; k < nB; k++) {
            const nextK = (k + 1) % nB;
            const b1 = ptsB[k].position;
            const b2 = ptsB[nextK].position;

            const ex = b2.x - b1.x;
            const ey = b2.y - b1.y;
            const lenSq = ex * ex + ey * ey;

            let t = 0;
            if (lenSq > 1e-8) {
                t = ((px - b1.x) * ex + (py - b1.y) * ey) / lenSq;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
            }

            const qx = b1.x + ex * t;
            const qy = b1.y + ey * t;
            const dx = qx - px;
            const dy = qy - py;
            const distSq = dx * dx + dy * dy;

            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestIdx1 = k;
                bestIdx2 = nextK;
                bestT = t;
                bestQx = qx;
                bestQy = qy;
            }
        }

        // 内部から最近傍エッジ外側への脱出方向ベクトルを算出
        const dist = Math.sqrt(bestDistSq);

        // 微小侵入スロップ（0.35px デッドゾーン）：下敷き圧迫時の微振動ループを物理遮断
        if (dist < effectiveSlop) {
            continue;
        }

        let ux = 0;
        let uy = 0;
        if (dist > 1e-4) {
            ux = (bestQx - px) / dist;
            uy = (bestQy - py) / dist;
        } else if (centB) {
            const rx = bestQx - centB.x;
            const ry = bestQy - centB.y;
            const rLen = Math.sqrt(rx * rx + ry * ry);
            if (rLen > 1e-4) {
                ux = rx / rLen;
                uy = ry / rLen;
            } else {
                ux = 0;
                uy = -1;
            }
        }

        // 上段待機カプセル同士の「横排斥バイアス」：上下へえぐらず左右へ綺麗に押し分ける
        if (bothFloating) {
            let horizDir = ux >= 0 ? 1 : -1;
            if (centA && centB && Math.abs(centA.x - centB.x) > 0.01) {
                horizDir = (centA.x > centB.x) ? 1 : -1;
            }
            const biasedX = ux * 0.35 + horizDir * 0.85;
            const biasedY = uy * 0.25;
            const bLen = Math.sqrt(biasedX * biasedX + biasedY * biasedY);
            if (bLen > 1e-4) {
                ux = biasedX / bLen;
                uy = biasedY / bLen;
            }
        }

        const effectivePenetration = Math.max(0, dist - effectiveSlop);
        const push = Math.min(maxPush, (effectivePenetration + sepPad) * stiffness);
        if (push <= 0.001) continue;

        // 作用・反作用の配分：侵入ビーズ側へ62%、相手エッジ周辺（隣接ビーズ含む）へ38%
        const pushA = push * 0.62;
        const pushB = push * 0.38;

        // (A) 侵入ビーズ側も対称分散（本体64% ＋ 両隣ビーズ各18%）で押し戻し変位を蓄積し、ツノ・クチバシ奇形を根絶
        const idxPrevA = (i - 1 + nA) % nA;
        const idxNextA = (i + 1) % nA;
        const mainPushA = pushA * 0.64;
        const sidePushA = pushA * 0.18;
        pushAccumAX[i] += ux * mainPushA;
        pushAccumAY[i] += uy * mainPushA;
        pushAccumAX[idxPrevA] += ux * sidePushA;
        pushAccumAY[idxPrevA] += uy * sidePushA;
        pushAccumAX[idxNextA] += ux * sidePushA;
        pushAccumAY[idxNextA] += uy * sidePushA;
        hasAnyPushA = true;

        // 双方衝突法線速度吸収（侵入ビーズ側：隙間進入と連動波及を活かすため吸収率を 0.56 へ緩和）
        const velDotA = p.velocity.x * ux + p.velocity.y * uy;
        if (velDotA < 0) {
            tempVel.x = p.velocity.x - ux * velDotA * 0.56;
            tempVel.y = p.velocity.y - uy * velDotA * 0.56;
            Body.setVelocity(p, tempVel);
        }

        // (B) 相手エッジへの反作用を隣接ビーズへも滑らかに分散蓄積（局所的なえぐれ・引きつり防止）
        // あわせて相手エッジ側ビーズの衝突法線接近速度も吸収しジッターを遮断しつつ周囲連動を滑らかに伝達
        const w1 = 1 - bestT;
        const w2 = bestT;
        const b1Body = ptsB[bestIdx1];
        const b2Body = ptsB[bestIdx2];

        if (nB >= 4) {
            const idxPrev = (bestIdx1 - 1 + nB) % nB;
            const idxNext = (bestIdx2 + 1) % nB;
            const bPrevBody = ptsB[idxPrev];
            const bNextBody = ptsB[idxNext];

            // エッジ両端へ計70%、両外側の隣接ビーズへ計30%を射影比率（w1, w2）で分散
            const mainScale = 0.70;
            const sideScale = 0.30;

            if (w1 > 0.001) {
                const m1 = pushB * mainScale * w1;
                const s1 = pushB * sideScale * w1;
                pushAccumBX[bestIdx1] -= ux * m1;
                pushAccumBY[bestIdx1] -= uy * m1;
                pushAccumBX[idxPrev] -= ux * s1;
                pushAccumBY[idxPrev] -= uy * s1;
                hasAnyPushB = true;
                absorbEdgeApproachVelocity(b1Body, ux, uy, 0.40 * w1);
                absorbEdgeApproachVelocity(bPrevBody, ux, uy, 0.18 * w1);
            }
            if (w2 > 0.001) {
                const m2 = pushB * mainScale * w2;
                const s2 = pushB * sideScale * w2;
                pushAccumBX[bestIdx2] -= ux * m2;
                pushAccumBY[bestIdx2] -= uy * m2;
                pushAccumBX[idxNext] -= ux * s2;
                pushAccumBY[idxNext] -= uy * s2;
                hasAnyPushB = true;
                absorbEdgeApproachVelocity(b2Body, ux, uy, 0.40 * w2);
                absorbEdgeApproachVelocity(bNextBody, ux, uy, 0.18 * w2);
            }
        } else {
            if (w1 > 0.001) {
                pushAccumBX[bestIdx1] -= ux * pushB * w1;
                pushAccumBY[bestIdx1] -= uy * pushB * w1;
                hasAnyPushB = true;
                absorbEdgeApproachVelocity(b1Body, ux, uy, 0.40 * w1);
            }
            if (w2 > 0.001) {
                pushAccumBX[bestIdx2] -= ux * pushB * w2;
                pushAccumBY[bestIdx2] -= uy * pushB * w2;
                hasAnyPushB = true;
                absorbEdgeApproachVelocity(b2Body, ux, uy, 0.40 * w2);
            }
        }
    }

    // 蓄積した排斥変位を 1 ビーズあたり最大 1 回の Body.setPosition で一括適用
    if (hasAnyPushA) {
        for (let i = 0; i < nA; i++) {
            const dx = pushAccumAX[i];
            const dy = pushAccumAY[i];
            if (dx !== 0 || dy !== 0) {
                applyClampedPush(ptsA[i], dx, dy, rA);
            }
        }
    }
    if (hasAnyPushB) {
        for (let i = 0; i < nB; i++) {
            const dx = pushAccumBX[i];
            const dy = pushAccumBY[i];
            if (dx !== 0 || dy !== 0) {
                applyClampedPush(ptsB[i], dx, dy, rB);
            }
        }
    }
}

/**
 * 全ソフトボディペア間で AABB 高速絞り込み ＋ Point-in-Polygon 非侵入排斥を実行する
 * （isBarHopping 飛行中ゼリー、斜め下すり抜け保護中 barGraceActive × isFloating ペア、
 *   および合体ディレイ中のペア同士は自動除外）
 * @param {Array<Matter.Composite>} jellies - 有効なソフトボディコンポジット配列
 */
export function solveAntiOverlap(jellies) {
    if (!jellies) return;
    const count = jellies.length;
    if (count < 2) return;

    const stiffness = PHYSICS.ANTI_OVERLAP_STIFFNESS || 0.68;
    const maxPush = PHYSICS.ANTI_OVERLAP_MAX_PUSH || 3.8;
    const slop = (PHYSICS.OVERLAP_SLOP !== undefined) ? PHYSICS.OVERLAP_SLOP : 0.35;

    for (let i = 0; i < count; i++) {
        const compA = jellies[i];
        // 2.5D飛び越えレーン飛行中のゼリーは他の待機・下段ゼリーと排斥干渉させない
        if (!compA || compA.isBarHopping || !compA.aabb) continue;

        const aA = compA.aabb;
        const rA = compA.particleRadius || 4;

        for (let j = i + 1; j < count; j++) {
            const compB = jellies[j];
            if (!compB || compB.isBarHopping || !compB.aabb) continue;

            // 斜め下ショットすり抜け保護中（barGraceActive）と上段待機（isFloating）のペアは衝突マスクと同期して除外
            if ((compA.barGraceActive && compB.isFloating) ||
                (compB.barGraceActive && compA.isFloating)) {
                continue;
            }

            // 合体前の「吸い付きの間」を演出するため、合体ディレイ中のペア同士は排斥を除外
            if (isMergingPair(compA, compB)) continue;

            const aB = compB.aabb;
            const rB = compB.particleRadius || 4;
            const pad = rA + rB;

            // 広域AABB判定：重なっていないペアは即スキップ
            if (aA.maxX + pad < aB.minX || aA.minX - pad > aB.maxX ||
                aA.maxY + pad < aB.minY || aA.minY - pad > aB.maxY) {
                continue;
            }

            // 双方のビーズに対して相手のポリゴン内部への侵入をチェック＆分散排斥
            resolvePolygonIntrusion(compA, compB, stiffness, maxPush, slop);
            resolvePolygonIntrusion(compB, compA, stiffness, maxPush, slop);
        }
    }
}