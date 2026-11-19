/**
 * overlap_solver.js
 * @version v5.0 (Final Overhaul & Refactoring Step 3 - New Module)
 * @changes
 *   - softbody.js と render.js で重複していた Ray-Casting ポリゴン包含判定を共通関数 isPointInsidePolygon() として独立化（Matter.Body 配列・{x, y} 座標バッファの両形式にゼロアロケーション対応）
 *   - 侵入ビーズの押し戻し反作用を相手エッジの2点だけに集中させず、その両外側にある隣接ビーズへも滑らかに分散させることで、下段ゼリーの局所的なえぐれ・引きつりを防止
 *   - 合体前の「吸い付きの間」を自然に演出するため、合体ディレイ中（isMerging）の合体対象ペア同士を排斥計算から除外
 *   - 2.5D飛び越えレーン方式の上段ホップに対応し、飛行中（isBarHopping）のゼリーが他の待機・下段ゼリーと排斥干渉しないよう除外処理を追加
 *   - GRAVITYキャッシュ不整合対策として constants.js / physics.js の絶対パスを ?v=5 へ統一
 * 
 * ソフトボディ間の「非侵入（Anti-Overlap）排斥ソルバー」および共通幾何判定を提供するモジュール
 * 
 * 広域AABB高速絞り込み ＋ Point-in-Polygon 包含判定 ＋ 最近傍エッジ外向き分散排斥により、
 * 中空ビーズリング同士のめり込み・重なり固定を物理的に解消します。
 */

import Matter from 'https://esm.sh/matter-js';
import { PHYSICS } from '/sobosuba/constants.js?v=5';
import { clampPointToContainer } from '/sobosuba/physics.js?v=5';

const Body = Matter.Body;

// ゼロアロケーション（毎サブステップGC負荷削減）用のクランプ出力先バッファ
const tempClampPoint = { x: 0, y: 0 };

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
                (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi)) {
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
                (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi)) {
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
 * 指定ビーズへ指定量の位置補正を安全（壁・45度スロープ内クランプ付き）に適用する
 * @param {Matter.Body} body - 対象ビーズ
 * @param {number} dx - X方向移動量
 * @param {number} dy - Y方向移動量
 * @param {number} margin - 壁・スロープからの内側マージン（ビーズ半径）
 */
function applyClampedPush(body, dx, dy, margin) {
    if (!body) return;
    const nextPt = clampPointToContainer(
        body.position.x + dx,
        body.position.y + dy,
        margin,
        tempClampPoint
    );
    Body.setPosition(body, { x: nextPt.x, y: nextPt.y });
}

/**
 * 侵入したビーズ（ゼリーA側）を相手ゼリーBの最近傍エッジ外側へ押し戻し、
 * 相手側のエッジ2点およびその外側隣接2ビーズへ反作用を滑らかに分散させる
 * @param {Matter.Composite} compA - 侵入側ゼリー
 * @param {Matter.Composite} compB - 侵入された側ゼリー
 * @param {number} stiffness - 排斥強度
 * @param {number} maxPush - 1サブステップあたりの最大押し出し量（px）
 */
function resolvePolygonIntrusion(compA, compB, stiffness, maxPush) {
    const ptsA = compA.particles;
    const ptsB = compB.particles;
    if (!ptsA || !ptsB) return;

    const nA = ptsA.length;
    const nB = ptsB.length;
    if (nA < 3 || nB < 3) return;

    const rA = compA.particleRadius || 4;
    const rB = compB.particleRadius || 4;
    const aabbB = compB.aabb;
    const centB = compB.centroid;
    const sepPad = (rA + rB) * 0.35;

    for (let i = 0; i < nA; i++) {
        const p = ptsA[i];
        const px = p.position.x;
        const py = p.position.y;

        // 相手ポリゴンのタイトAABB外なら即スキップ（高速化）
        if (aabbB && (px < aabbB.minX || px > aabbB.maxX || py < aabbB.minY || py > aabbB.maxY)) {
            continue;
        }

        // Point-in-Polygon 包含判定（相手リングの内部空洞へ侵入しているビーズのみ対象）
        if (!isPointInsidePolygon(px, py, ptsB, nB)) {
            continue;
        }

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

        const push = Math.min(maxPush, (dist + sepPad) * stiffness);
        if (push <= 0.001) continue;

        // 作用・反作用の配分：侵入ビーズ側へ62%、相手エッジ周辺（隣接ビーズ含む）へ38%
        const pushA = push * 0.62;
        const pushB = push * 0.38;

        // (A) 侵入ビーズ本体を外側へ押し戻す
        applyClampedPush(p, ux * pushA, uy * pushA, rA);

        // 侵入方向へ潜り込み続ける速度成分を打ち消して再侵入を防ぐ
        const velDot = p.velocity.x * ux + p.velocity.y * uy;
        if (velDot < 0) {
            Body.setVelocity(p, {
                x: p.velocity.x - ux * velDot * 0.6,
                y: p.velocity.y - uy * velDot * 0.6
            });
        }

        // (B) 相手エッジへの反作用を隣接ビーズへも滑らかに分散（局所的なえぐれ・引きつり防止）
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
                applyClampedPush(b1Body, -ux * m1, -uy * m1, rB);
                applyClampedPush(bPrevBody, -ux * s1, -uy * s1, rB);
            }
            if (w2 > 0.001) {
                const m2 = pushB * mainScale * w2;
                const s2 = pushB * sideScale * w2;
                applyClampedPush(b2Body, -ux * m2, -uy * m2, rB);
                applyClampedPush(bNextBody, -ux * s2, -uy * s2, rB);
            }
        } else {
            if (w1 > 0.001) {
                applyClampedPush(b1Body, -ux * pushB * w1, -uy * pushB * w1, rB);
            }
            if (w2 > 0.001) {
                applyClampedPush(b2Body, -ux * pushB * w2, -uy * pushB * w2, rB);
            }
        }
    }
}

/**
 * 全ソフトボディペア間で AABB 高速絞り込み ＋ Point-in-Polygon 非侵入排斥を実行する
 * （isBarHopping 飛行中ゼリーおよび合体ディレイ中のペア同士は自動除外）
 * @param {Array<Matter.Composite>} jellies - 有効なソフトボディコンポジット配列
 */
export function solveAntiOverlap(jellies) {
    if (!jellies) return;
    const count = jellies.length;
    if (count < 2) return;

    const stiffness = PHYSICS.ANTI_OVERLAP_STIFFNESS || 0.65;
    const maxPush = PHYSICS.ANTI_OVERLAP_MAX_PUSH || 4.0;

    for (let i = 0; i < count; i++) {
        const compA = jellies[i];
        // 2.5D飛び越えレーン飛行中のゼリーは他の待機・下段ゼリーと排斥干渉させない
        if (!compA || compA.isBarHopping || !compA.aabb) continue;

        const aA = compA.aabb;
        const rA = compA.particleRadius || 4;

        for (let j = i + 1; j < count; j++) {
            const compB = jellies[j];
            if (!compB || compB.isBarHopping || !compB.aabb) continue;

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
            resolvePolygonIntrusion(compA, compB, stiffness, maxPush);
            resolvePolygonIntrusion(compB, compA, stiffness, maxPush);
        }
    }
}