/**
 * softbody.js
 * @version v4.0 (Final Overhaul Step 6)
 * @changes
 *   - 下段の塊の変な重なり合いを根絶するため、AABB高速絞り込み＋Point-in-Polygon包含判定＋最近傍エッジ外向き排斥によるソフトボディ間「非侵入（Anti-Overlap）排斥ソルバー」を実装
 *   - BEAD_RADIUS_RATIO / BEAD_MIN_OVERLAP_RATIO に基づく「隙間ゼロ」高密度シームレス・ビーズリング構造へ刷新し、力ベース内圧主軸化＆極小PBD上限（0.6px/step）へ最適化
 *   - physics.js の clampPointToContainer() を連携し、PBD補正・アンチ裏返り修復・非侵入排斥のすべてで底面45度角カットスロープ貫通を防止
 *   - アンチ裏返り修復時の continue による無重力・ホップ・速度クランプのスキップバグを修正し、作業配列の事前確保により毎サブステップのGC負荷を削減
 *   - 合体時の「縮小スポーン（initialScale）→ 膨張成長（Grow-In）」と、上段飛び越えホップ（launchBarHop）＆下降時の自動再吸着（リキャッチ）物理を実装
 *   - GRAVITYキャッシュ不整合対策として constants.js / physics.js の絶対パスを ?v=4 へ統一
 * 
 * ソフトボディ（中空ビーズリング剛体）の生成・物理更新モジュール
 * 
 * 中心に剛体コアを持たず、外周の隙間ゼロ数珠つなぎビーズと表面張力・曲げ拘束・
 * 力ベース内部圧力・非侵入排斥ソルバーにより、重なり合わず水風船のように流動的に
 * 変形する本家sobosuba風の挙動および上段飛び越えホップを実現します。
 * ESM経由でMatter.jsを直接読み込み、起動エラーを防ぎます。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, PHYSICS, JELLY_CONFIG, FLOAT_BAR, EFFECTS } from '/sobosuba/constants.js?v=4';
import { clampPointToContainer } from '/sobosuba/physics.js?v=4';

const Bodies = Matter.Bodies;
const Composite = Matter.Composite;
const Constraint = Matter.Constraint;
const Body = Matter.Body;

// ゼリーを一意に識別するためのカウンター（合体判定などで使用）
let jellyIdCounter = 0;

// ==========================================
// ゼロアロケーション（毎サブステップGC負荷削減）用作業バッファ
// ==========================================
const activeJelliesBuffer = [];
const tempClampPoint = { x: 0, y: 0 };

/**
 * 中空ビーズリング型ソフトボディゼリー（Sobo）を生成する
 * @param {number} x - 生成する中心X座標
 * @param {number} y - 生成する中心Y座標
 * @param {number} value - ゼリーの数値 (1, 2, 4, 8...)
 * @param {Object|null} initialVelocity - 生成時の初速ベクトル {x, y} (無い場合はnull)
 * @param {boolean} isFloating - 上部フロートバー上で無重力浮遊させるかどうか
 * @param {boolean} hasMerged - 既に合体に参加済み（スコア加算済み・太字表示）かどうか
 * @param {number} initialScale - 合体時の縮小スポーン開始倍率（通常1.0、合体時0.75等）
 * @returns {Matter.Composite} 生成された中空ビーズリングの複合体
 */
export function createSoftBodyJelly(x, y, value, initialVelocity = null, isFloating = false, hasMerged = false, initialScale = 1.0) {
    const config = JELLY_CONFIG[value] || JELLY_CONFIG[16384] || JELLY_CONFIG[8192];
    const radius = config.radius;
    const particleCount = Math.max(14, config.particles || 14);

    // 隙間ゼロ高密度シームレス・ビーズリング半径の算出
    // 隣接ビーズ直径 >= BEAD_MIN_OVERLAP_RATIO * 弦長 を数学的に保証する
    const beadRatio = PHYSICS.BEAD_RADIUS_RATIO || 0.26;
    const minOverlap = PHYSICS.BEAD_MIN_OVERLAP_RATIO || 1.35;
    const sinHalf = Math.sin(Math.PI / particleCount);
    const minSeamlessBeadRadius = (minOverlap * sinHalf / (1 + minOverlap * sinHalf)) * radius;
    const particleRadius = Math.max(3.5, radius * beadRatio, minSeamlessBeadRadius);
    const fullRingRadius = Math.max(4, radius - particleRadius);

    // 合体時「縮小スポーン → 膨張成長（Grow-In）」用の開始スケール設定
    const clampedStartScale = Math.max(0.5, Math.min(1.0, Number(initialScale) || 1.0));
    const spawnRingRadius = fullRingRadius * clampedStartScale;
    const isGrowing = clampedStartScale < 0.999;

    // ソフトボディ全体をまとめるコンポジット（複合体）
    const jellyComposite = Composite.create({ label: 'jelly_composite' });
    const currentJellyId = `jelly_${jellyIdCounter++}`;
    const createdAt = Date.now();

    // 同一ゼリー内のビーズ同士が反発して爆発するのを防ぐ負のコリジョングループ
    const group = Body.nextGroup(true);

    // ==========================================
    // 1. 外周ビーズ剛体（隙間ゼロ中空リング：中心コアなし）の生成
    // ==========================================
    const particles = [];

    for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2;
        // 中心から時計回り（Canvas座標系）にリング配置（壁・スロープ内へ安全クランプ）
        const rawPx = x + Math.cos(angle) * spawnRingRadius;
        const rawPy = y + Math.sin(angle) * spawnRingRadius;
        const clamped = clampPointToContainer(rawPx, rawPy, particleRadius, tempClampPoint);

        const particle = Bodies.circle(clamped.x, clamped.y, particleRadius, {
            density: PHYSICS.DENSITY_PARTICLE,
            friction: PHYSICS.FRICTION,
            frictionStatic: PHYSICS.FRICTION_STATIC,
            frictionAir: PHYSICS.FRICTION_AIR,
            restitution: PHYSICS.RESTITUTION,
            label: 'jelly_particle',
            collisionFilter: { group: group }
        });

        // 衝突判定・合体・回転角算出用のメタデータを付与
        particle.jellyValue = value;
        particle.jellyId = currentJellyId;
        particle.isMerging = false;
        particle.parentComposite = jellyComposite;
        particle.particleRadius = particleRadius;
        particle.initialAngle = angle;

        particles.push(particle);
        Composite.add(jellyComposite, particle);
    }

    // ==========================================
    // 2. 隣接ビーズ間の皮の張りバネ（表面張力）の生成
    // ==========================================
    const fullSegmentLength = 2 * fullRingRadius * Math.sin(Math.PI / particleCount);
    const skinConstraints = [];

    for (let i = 0; i < particleCount; i++) {
        const p1 = particles[i];
        const p2 = particles[(i + 1) % particleCount];

        const skinConstraint = Constraint.create({
            bodyA: p1,
            bodyB: p2,
            length: fullSegmentLength * clampedStartScale,
            stiffness: PHYSICS.SKIN_STIFFNESS,
            damping: PHYSICS.SOFTBODY_DAMPING,
            render: { visible: false }
        });
        skinConstraints.push(skinConstraint);
        Composite.add(jellyComposite, skinConstraint);
    }

    // ==========================================
    // 3. 1つ飛ばしビーズ間の弱い曲げ拘束（シワ折れ・鋭角崩壊防止）
    // ==========================================
    const fullBendLength = 2 * fullRingRadius * Math.sin((2 * Math.PI) / particleCount);
    const bendConstraints = [];

    for (let i = 0; i < particleCount; i++) {
        const p1 = particles[i];
        const p2 = particles[(i + 2) % particleCount];

        const bendConstraint = Constraint.create({
            bodyA: p1,
            bodyB: p2,
            length: fullBendLength * clampedStartScale,
            stiffness: PHYSICS.BEND_STIFFNESS,
            damping: PHYSICS.SOFTBODY_DAMPING,
            render: { visible: false }
        });
        bendConstraints.push(bendConstraint);
        Composite.add(jellyComposite, bendConstraint);
    }

    const fullTargetArea = 0.5 * particleCount * fullRingRadius * fullRingRadius * Math.sin((2 * Math.PI) / particleCount);

    // コンポジット自体に高速参照用・物理更新用のメタデータを保持
    jellyComposite.jellyId = currentJellyId;
    jellyComposite.jellyValue = value;
    jellyComposite.isMerging = false;
    jellyComposite.isFloating = Boolean(isFloating);
    jellyComposite.isBarHopping = false;
    jellyComposite.hopStartTime = 0;
    jellyComposite.hasMerged = Boolean(hasMerged);
    jellyComposite.createdAt = createdAt;
    jellyComposite.particles = particles;
    jellyComposite.skinConstraints = skinConstraints;
    jellyComposite.bendConstraints = bendConstraints;
    jellyComposite.targetRadius = radius;
    jellyComposite.fullRingRadius = fullRingRadius;
    jellyComposite.ringRadius = spawnRingRadius;
    jellyComposite.particleRadius = particleRadius;
    jellyComposite.fullSegmentLength = fullSegmentLength;
    jellyComposite.fullBendLength = fullBendLength;
    jellyComposite.fullTargetArea = fullTargetArea;
    jellyComposite.targetArea = fullTargetArea * clampedStartScale * clampedStartScale;
    jellyComposite.isGrowing = isGrowing;
    jellyComposite.growStartScale = clampedStartScale;
    jellyComposite.growDurationMs = EFFECTS.MERGE_GROW_DURATION_MS || 150;
    jellyComposite.centroid = { x, y };
    jellyComposite.avgAngle = 0;
    jellyComposite.aabb = { minX: x - radius, maxX: x + radius, minY: y - radius, maxY: y + radius };

    // ==========================================
    // 4. 初期速度の付与
    // ==========================================
    if (initialVelocity) {
        const vx = initialVelocity.x || 0;
        const vy = initialVelocity.y || 0;
        for (let i = 0; i < particles.length; i++) {
            Body.setVelocity(particles[i], { x: vx, y: vy });
        }
    }

    return jellyComposite;
}

/**
 * 中空ビーズリングの現在重心座標を安全に取得する
 * @param {Matter.Composite} jellyComposite - 対象のゼリーコンポジット
 * @returns {{ x: number, y: number } | null}
 */
export function getSoftBodyCentroid(jellyComposite) {
    if (!jellyComposite) return null;
    const particles = jellyComposite.particles;
    if (!particles || particles.length === 0) {
        return jellyComposite.centroid || null;
    }

    let cx = 0;
    let cy = 0;
    const n = particles.length;
    for (let i = 0; i < n; i++) {
        cx += particles[i].position.x;
        cy += particles[i].position.y;
    }
    cx /= n;
    cy /= n;

    if (!jellyComposite.centroid) {
        jellyComposite.centroid = { x: cx, y: cy };
    } else {
        jellyComposite.centroid.x = cx;
        jellyComposite.centroid.y = cy;
    }
    return jellyComposite.centroid;
}

/**
 * フロートバー上のゼリーを無重力状態から解除し、現在の移動速度に加算（Additive Momentum）して下段へ発射する
 * @param {Matter.Composite} jellyComposite - 発射するゼリーのコンポジット
 * @param {Object} addVelocity - 加算する発射速度ベクトル {x, y}（そっと落とし時は {x: 0, y: 0}）
 */
export function launchFloatingJelly(jellyComposite, addVelocity = { x: 0, y: 0 }) {
    if (!jellyComposite) return;
    jellyComposite.isFloating = false;
    jellyComposite.isBarHopping = false;
    jellyComposite.hopStartTime = 0;

    const particles = jellyComposite.particles;
    if (!particles || particles.length === 0) return;

    const addX = addVelocity ? (addVelocity.x || 0) : 0;
    const addY = addVelocity ? (addVelocity.y || 0) : 0;
    const maxSpeed = PHYSICS.MAX_PARTICLE_SPEED || 4.5;
    const maxSpeedSq = maxSpeed * maxSpeed;

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        // 本家v1.2準拠：バー上での横移動速度を保持したまま発射ベクトルを加算する
        let vx = p.velocity.x + addX;
        let vy = p.velocity.y + addY;

        const speedSq = vx * vx + vy * vy;
        if (speedSq > maxSpeedSq) {
            const scale = maxSpeed / Math.sqrt(speedSq);
            vx *= scale;
            vy *= scale;
        }
        Body.setVelocity(p, { x: vx, y: vy });
    }
}

/**
 * 上段フロートバーのゼリーを「上段飛び越えホップ（Bar-Hop）」状態で発射する
 * 隣の塊を山なりアーチで飛び越え、下降時に上段バーへ自動再吸着（リキャッチ）される
 * @param {Matter.Composite} jellyComposite - ホップさせるゼリーのコンポジット
 * @param {Object} hopVelocity - ホップ初速ベクトル {x, y}（px/substep 単位）
 */
export function launchBarHop(jellyComposite, hopVelocity = { x: 0, y: -2.0 }) {
    if (!jellyComposite) return;
    jellyComposite.isFloating = false;
    jellyComposite.isBarHopping = true;
    jellyComposite.hopStartTime = Date.now();

    const particles = jellyComposite.particles;
    if (!particles || particles.length === 0) return;

    const hopX = hopVelocity ? (hopVelocity.x || 0) : 0;
    const hopY = hopVelocity ? (hopVelocity.y || 0) : -2.0;
    const maxHopSpeed = Math.min(
        FLOAT_BAR.HOP_MAX_SPEED || 3.9,
        PHYSICS.MAX_PARTICLE_SPEED || 4.5
    );
    const maxHopSpeedSq = maxHopSpeed * maxHopSpeed;

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        // バー上の横運動量を緩やかに継承しつつ、正確なアーチ軌道を描くようY速度はホップ初速を採用
        let vx = p.velocity.x * 0.4 + hopX;
        let vy = hopY;

        const speedSq = vx * vx + vy * vy;
        if (speedSq > maxHopSpeedSq) {
            const scale = maxHopSpeed / Math.sqrt(speedSq);
            vx *= scale;
            vy *= scale;
        }
        Body.setVelocity(p, { x: vx, y: vy });
    }
}

/**
 * 点 (px, py) が相手ゼリーの外周ポリゴン内部にあるか Ray-Casting で判定する
 * @param {number} px
 * @param {number} py
 * @param {Array<Matter.Body>} polyParticles
 * @returns {boolean}
 */
function isPointInsidePolygon(px, py, polyParticles) {
    let inside = false;
    const m = polyParticles.length;
    for (let k = 0, l = m - 1; k < m; l = k++) {
        const xi = polyParticles[k].position.x;
        const yi = polyParticles[k].position.y;
        const xj = polyParticles[l].position.x;
        const yj = polyParticles[l].position.y;

        if (((yi > py) !== (yj > py)) &&
            (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * 侵入したビーズ（ゼリーA側）を相手ゼリーBの最近傍エッジ外側へ押し戻し、
 * エッジ側の2ビーズにも反作用を返す非侵入排斥処理
 * @param {Matter.Composite} compA - 侵入側ゼリー
 * @param {Matter.Composite} compB - 侵入された側ゼリー
 * @param {number} stiffness - 排斥強度
 * @param {number} maxPush - 1サブステップあたりの最大押し出し量
 */
function resolvePolygonIntrusion(compA, compB, stiffness, maxPush) {
    const ptsA = compA.particles;
    const ptsB = compB.particles;
    const nA = ptsA.length;
    const nB = ptsB.length;
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
        if (px < aabbB.minX || px > aabbB.maxX || py < aabbB.minY || py > aabbB.maxY) {
            continue;
        }

        // Point-in-Polygon 包含判定（相手リングの内部空洞へ侵入しているビーズのみ対象）
        if (!isPointInsidePolygon(px, py, ptsB)) {
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

        // 作用・反作用：侵入ビーズ側へ65%、相手エッジ両端へ35%を線形配分で押し戻す
        const pushA = push * 0.65;
        const pushB = push * 0.35;

        const nextA = clampPointToContainer(px + ux * pushA, py + uy * pushA, rA, tempClampPoint);
        Body.setPosition(p, { x: nextA.x, y: nextA.y });

        // 侵入方向へ潜り込み続ける速度成分を打ち消して再侵入を防ぐ
        const velDot = p.velocity.x * ux + p.velocity.y * uy;
        if (velDot < 0) {
            Body.setVelocity(p, {
                x: p.velocity.x - ux * velDot * 0.6,
                y: p.velocity.y - uy * velDot * 0.6
            });
        }

        const b1Body = ptsB[bestIdx1];
        const b2Body = ptsB[bestIdx2];
        const w1 = 1 - bestT;
        const w2 = bestT;

        if (w1 > 0.001) {
            const nextB1 = clampPointToContainer(
                b1Body.position.x - ux * pushB * w1,
                b1Body.position.y - uy * pushB * w1,
                rB,
                tempClampPoint
            );
            Body.setPosition(b1Body, { x: nextB1.x, y: nextB1.y });
        }

        if (w2 > 0.001) {
            const nextB2 = clampPointToContainer(
                b2Body.position.x - ux * pushB * w2,
                b2Body.position.y - uy * pushB * w2,
                rB,
                tempClampPoint
            );
            Body.setPosition(b2Body, { x: nextB2.x, y: nextB2.y });
        }
    }
}

/**
 * 全ソフトボディペア間で AABB 高速絞り込み ＋ Point-in-Polygon 非侵入排斥を実行する
 */
function solveAntiOverlap(jellies) {
    const count = jellies.length;
    if (count < 2) return;

    const stiffness = PHYSICS.ANTI_OVERLAP_STIFFNESS || 0.72;
    const maxPush = PHYSICS.ANTI_OVERLAP_MAX_PUSH || 4.5;

    for (let i = 0; i < count; i++) {
        const compA = jellies[i];
        const aA = compA.aabb;
        const rA = compA.particleRadius || 4;

        for (let j = i + 1; j < count; j++) {
            const compB = jellies[j];
            const aB = compB.aabb;
            const rB = compB.particleRadius || 4;
            const pad = rA + rB;

            // 広域AABB判定：重なっていないペアは即スキップ
            if (aA.maxX + pad < aB.minX || aA.minX - pad > aB.maxX ||
                aA.maxY + pad < aB.minY || aA.minY - pad > aB.maxY) {
                continue;
            }

            // 双方のビーズに対して相手のポリゴン内部への侵入をチェック＆排斥
            resolvePolygonIntrusion(compA, compB, stiffness, maxPush);
            resolvePolygonIntrusion(compB, compA, stiffness, maxPush);
        }
    }
}

/**
 * 毎サブステップ呼び出されるソフトボディ物理更新関数
 * 1. 合体時「縮小スポーン → 膨張成長（Grow-In）」のバネ長・目標面積補間
 * 2. 靴紐の公式による重心・符号付き面積・周長・AABB・平均回転角の算出
 * 3. アンチ裏返り自動修復（45度スロープ対応クランプ＆後続処理スキップなし）
 * 4. 力ベース内圧主軸 ＆ 極小PBD面積保存補正 ＆ 最小距離復元
 * 5. 上部フロートバー無重力フック ＆ 上段飛び越えホップ専用重力・自動再吸着（リキャッチ）
 * 6. 全ビーズの最大速度クランプ
 * 7. ソフトボディ間「非侵入（Anti-Overlap）排斥ソルバー」の実行
 * @param {Matter.World} world - Matter.jsの物理世界
 * @param {Matter.Engine} engine - Matter.jsのエンジン
 */
export function updateSoftBodies(world, engine) {
    if (!world || !engine) return;

    // 毎サブステップの配列新規生成（GC負荷）を避けるため world.composites を直接走査
    const composites = world.composites || [];
    const gravityY = engine.gravity.y;
    const gravityScale = engine.gravity.scale;
    const substeps = Math.max(1, PHYSICS.SUBSTEPS || 4);
    const maxSpeed = PHYSICS.MAX_PARTICLE_SPEED || 4.5;
    const maxSpeedSq = maxSpeed * maxSpeed;
    const pbdStiffnessPerStep = (PHYSICS.PBD_AREA_STIFFNESS || 0.25) / substeps;
    const maxCorr = PHYSICS.PBD_MAX_CORRECTION || 0.6;
    const inversionRatio = PHYSICS.INVERSION_AREA_RATIO || 0.25;
    const minDistRatio = PHYSICS.SOFTBODY_MIN_DIST_RATIO || 0.45;
    const pressureCoeff = PHYSICS.SOFTBODY_PRESSURE || 0.00085;
    const packForce = FLOAT_BAR.PACK_FORCE || 0.00005;

    // 上段飛び越えホップ＆再吸着パラメータ
    const hopGravityScale = (FLOAT_BAR.HOP_GRAVITY_SCALE !== undefined) ? FLOAT_BAR.HOP_GRAVITY_SCALE : 0.65;
    const hopMinAirMs = FLOAT_BAR.HOP_MIN_AIR_MS || 110;
    const hopRecatchYMin = FLOAT_BAR.HOP_RECATCH_Y_MIN || 92;
    const hopRecatchYMax = FLOAT_BAR.HOP_RECATCH_Y_MAX || 138;
    const hopMaxAirMs = FLOAT_BAR.HOP_MAX_AIR_MS || 2200;

    // 1フレームあたりの減衰率をサブステップ回数に応じて等価変換
    const stepDampX = Math.pow(FLOAT_BAR.X_DAMPING || 0.985, 1 / substeps);
    const stepDampY = Math.pow(FLOAT_BAR.Y_DAMPING || 0.88, 1 / substeps);

    const now = Date.now();
    activeJelliesBuffer.length = 0;

    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (!comp || comp.label !== 'jelly_composite') continue;

        const particles = comp.particles;
        if (!particles || particles.length < 3) continue;

        const n = particles.length;
        const pRadius = comp.particleRadius || 4;

        // ==========================================
        // 0. 合体時の「縮小スポーン → 膨張成長（Grow-In）」更新
        // ==========================================
        if (comp.isGrowing) {
            const elapsed = Math.max(0, now - (comp.createdAt || now));
            const duration = Math.max(1, comp.growDurationMs || 150);
            const rawT = Math.min(1, elapsed / duration);
            // 滑らかに周囲を押し退けながら定着する Ease-Out 補間
            const easedT = 1 - Math.pow(1 - rawT, 3);
            const startScale = comp.growStartScale || 0.75;
            const curScale = startScale + (1 - startScale) * easedT;

            comp.ringRadius = (comp.fullRingRadius || comp.ringRadius) * curScale;
            comp.targetArea = (comp.fullTargetArea || comp.targetArea) * curScale * curScale;

            const skinCs = comp.skinConstraints;
            if (skinCs) {
                const segLen = (comp.fullSegmentLength || 10) * curScale;
                for (let j = 0; j < skinCs.length; j++) {
                    skinCs[j].length = segLen;
                }
            }
            const bendCs = comp.bendConstraints;
            if (bendCs) {
                const bendLen = (comp.fullBendLength || 18) * curScale;
                for (let j = 0; j < bendCs.length; j++) {
                    bendCs[j].length = bendLen;
                }
            }

            if (rawT >= 1) {
                comp.isGrowing = false;
            }
        }

        const ringRadius = comp.ringRadius || 12;
        const targetArea = comp.targetArea || (Math.PI * ringRadius * ringRadius);

        // ==========================================
        // 1. 重心・符号付き面積（靴紐の公式）・周長・AABBを算出
        // ==========================================
        let cx = 0;
        let cy = 0;
        let signedArea = 0;
        let perimeter = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;

        for (let j = 0; j < n; j++) {
            const p1 = particles[j].position;
            const p2 = particles[(j + 1) % n].position;
            cx += p1.x;
            cy += p1.y;

            if (p1.x < minX) minX = p1.x;
            if (p1.x > maxX) maxX = p1.x;
            if (p1.y < minY) minY = p1.y;
            if (p1.y > maxY) maxY = p1.y;

            // Canvas座標系（Y軸下向き）で時計回り配置のため、正常時は正の面積になる
            signedArea += (p1.x * p2.y - p2.x * p1.y);
            const ex = p2.x - p1.x;
            const ey = p2.y - p1.y;
            perimeter += Math.sqrt(ex * ex + ey * ey);
        }
        cx /= n;
        cy /= n;
        signedArea *= 0.5;

        // 重心およびAABBをインプレース更新
        if (!comp.centroid) {
            comp.centroid = { x: cx, y: cy };
        } else {
            comp.centroid.x = cx;
            comp.centroid.y = cy;
        }
        if (!comp.aabb) {
            comp.aabb = { minX, maxX, minY, maxY };
        } else {
            comp.aabb.minX = minX;
            comp.aabb.maxX = maxX;
            comp.aabb.minY = minY;
            comp.aabb.maxY = maxY;
        }

        // ==========================================
        // 2 & 3. アンチ裏返り自動修復 OR 力ベース内圧主軸＋極小PBD面積保存
        // （continue を使わず、後続のバー無重力・ホップ制御・速度クランプを必ず実行）
        // ==========================================
        if (signedArea < targetArea * inversionRatio) {
            const baseAngle = comp.avgAngle || 0;
            const safeRadius = ringRadius * 0.88;
            const safeCenter = clampPointToContainer(cx, cy, pRadius + safeRadius, tempClampPoint);
            const safeCx = safeCenter.x;
            const safeCy = safeCenter.y;

            for (let j = 0; j < n; j++) {
                const pCurr = particles[j];
                const idealAngle = baseAngle + (pCurr.initialAngle !== undefined ? pCurr.initialAngle : ((j / n) * Math.PI * 2));
                const targetX = safeCx + Math.cos(idealAngle) * safeRadius;
                const targetY = safeCy + Math.sin(idealAngle) * safeRadius;

                // 現在位置から理想リング座標へ引き戻して裏返りを解除（45度スロープ内へクランプ）
                const nextX = pCurr.position.x + (targetX - pCurr.position.x) * 0.45;
                const nextY = pCurr.position.y + (targetY - pCurr.position.y) * 0.45;
                const clampedPt = clampPointToContainer(nextX, nextY, pRadius, tempClampPoint);

                Body.setPosition(pCurr, { x: clampedPt.x, y: clampedPt.y });
                Body.setVelocity(pCurr, {
                    x: pCurr.velocity.x * 0.55,
                    y: pCurr.velocity.y * 0.55
                });
            }
        } else {
            // 正常形状時の平均回転角（循環平均）を算出（数字の自然な回転追従用）
            let sumSin = 0;
            let sumCos = 0;
            for (let j = 0; j < n; j++) {
                const pCurr = particles[j];
                const dx = pCurr.position.x - cx;
                const dy = pCurr.position.y - cy;
                if (dx * dx + dy * dy > 0.01) {
                    const currAngle = Math.atan2(dy, dx);
                    const initAngle = pCurr.initialAngle !== undefined ? pCurr.initialAngle : ((j / n) * Math.PI * 2);
                    const diff = currAngle - initAngle;
                    sumSin += Math.sin(diff);
                    sumCos += Math.cos(diff);
                }
            }
            if (sumSin * sumSin + sumCos * sumCos > 0.0001) {
                comp.avgAngle = Math.atan2(sumSin, sumCos);
            }

            // (A) 補助的な極小PBD面積保存補正（他ゼリーや45度スロープへめり込ませない上限 0.6px/step）
            const areaDiff = targetArea - signedArea;
            const safePerimeter = Math.max(perimeter, 1);
            let pbdDelta = (areaDiff / safePerimeter) * pbdStiffnessPerStep;
            if (pbdDelta > maxCorr) pbdDelta = maxCorr;
            else if (pbdDelta < -maxCorr * 0.35) pbdDelta = -maxCorr * 0.35;

            // (B) 主軸となる力ベース内部圧力（ボヨンとした弾性・自然な押し合いを実現）
            const areaRatio = Math.max(-0.8, Math.min(2.2, areaDiff / targetArea));
            const pressureStrength = areaRatio * pressureCoeff * 5.0;
            const minDist = ringRadius * minDistRatio;

            for (let j = 0; j < n; j++) {
                const pPrev = particles[(j - 1 + n) % n].position;
                const pCurr = particles[j];
                const pNext = particles[(j + 1) % n].position;

                // 重心からの放射状ベクトルと距離を算出
                const dx = pCurr.position.x - cx;
                const dy = pCurr.position.y - cy;
                const dist = Math.sqrt(dx * dx + dy * dy);

                let radialX = 0;
                let radialY = 0;
                if (dist > 0.0001) {
                    radialX = dx / dist;
                    radialY = dy / dist;
                } else {
                    const fallbackAngle = (comp.avgAngle || 0) + (j / n) * Math.PI * 2;
                    radialX = Math.cos(fallbackAngle);
                    radialY = Math.sin(fallbackAngle);
                }

                // 隣接ビーズ間の接線ベクトルから外向き法線を求める
                const tx = pNext.x - pPrev.x;
                const ty = pNext.y - pPrev.y;
                const tLen = Math.sqrt(tx * tx + ty * ty);

                let nx = radialX;
                let ny = radialY;
                if (tLen > 0.0001) {
                    const candNx = ty / tLen;
                    const candNy = -tx / tLen;
                    // 重心から見て外向き（内積が正）の場合のみ接線法線を採用
                    if ((candNx * radialX + candNy * radialY) > 0) {
                        nx = candNx;
                        ny = candNy;
                    }
                }

                // 極小PBD位置補正（45度スロープ境界を含めて安全クランプ）
                if (Math.abs(pbdDelta) > 0.0005) {
                    const clampedPt = clampPointToContainer(
                        pCurr.position.x + nx * pbdDelta,
                        pCurr.position.y + ny * pbdDelta,
                        pRadius,
                        tempClampPoint
                    );
                    Body.setPosition(pCurr, { x: clampedPt.x, y: clampedPt.y });
                }

                // 主軸となる力ベース内部圧力
                const forceMag = pressureStrength * pCurr.mass;
                Body.applyForce(pCurr, pCurr.position, {
                    x: nx * forceMag,
                    y: ny * forceMag
                });

                // 最小距離復元（重心への過度なめり込みを防止）
                if (dist < minDist) {
                    const overlap = minDist - dist;
                    const restoreMag = overlap * 0.00045 * pCurr.mass;
                    Body.applyForce(pCurr, pCurr.position, {
                        x: radialX * restoreMag,
                        y: radialY * restoreMag
                    });
                }
            }
        }

        // ==========================================
        // 4. 上段飛び越えホップ専用重力 ＆ バー高度到達時の自動再吸着（リキャッチ）
        // ==========================================
        if (comp.isBarHopping) {
            let avgVy = 0;
            for (let j = 0; j < n; j++) {
                avgVy += particles[j].velocity.y;
            }
            avgVy /= n;

            const airMs = now - (comp.hopStartTime || now);
            // 下降フェーズでバー高度帯へ到達、または下抜け防止・タイムアウトで上段バーへ自動再吸着
            const isDescendingIntoBar = (airMs >= hopMinAirMs) && (
                (avgVy >= 0 && cy >= hopRecatchYMin && cy <= hopRecatchYMax) ||
                (cy > hopRecatchYMax)
            );
            const isTimedOut = airMs >= hopMaxAirMs;

            if (isDescendingIntoBar || isTimedOut) {
                comp.isBarHopping = false;
                comp.isFloating = true;
                comp.hopStartTime = 0;

                // 着地時の縦勢いを吸収し、横の勢いを適度に残して隣ゼリーとの合体・着地を滑らかにする
                for (let j = 0; j < n; j++) {
                    const body = particles[j];
                    Body.setVelocity(body, {
                        x: body.velocity.x * 0.65,
                        y: body.velocity.y * 0.15
                    });
                }
            } else {
                // ホップ滞空中：専用重力倍率（HOP_GRAVITY_SCALE = 0.65）になるよう差分を上向き相殺
                const cancelRatio = 1 - hopGravityScale;
                if (Math.abs(cancelRatio) > 0.0001) {
                    for (let j = 0; j < n; j++) {
                        const body = particles[j];
                        Body.applyForce(body, body.position, {
                            x: 0,
                            y: -gravityY * gravityScale * cancelRatio * body.mass
                        });
                    }
                }
            }
        }

        // ==========================================
        // 5. 上部フロートバー上での無重力弾性フック ＆ 低減衰横スライド制御
        // ==========================================
        if (comp.isFloating) {
            const targetY = FLOAT_BAR.Y;
            const centerX = GAME_WIDTH / 2;
            const barMinX = FLOAT_BAR.PADDING_X + comp.targetRadius;
            const barMaxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - comp.targetRadius;

            // 中央方向への微弱な寄せ力（左右端スポーナーからスルスル合流させる）
            const dxCenter = centerX - cx;
            const packRatio = Math.max(-1, Math.min(1, dxCenter / 40));

            for (let j = 0; j < n; j++) {
                const body = particles[j];

                // 重力打ち消し（無重力化）
                const antiGravityY = -gravityY * gravityScale * body.mass;

                // バーのY高度（FLOAT_BAR.Y）に柔らかく吊る弾性フック
                const dyBar = targetY - cy;
                const holdForceY = dyBar * FLOAT_BAR.SPRING_STIFFNESS * 0.00045 * body.mass;

                // 左右余白の保持 ＋ 穏やかな中央寄せ引力
                let holdForceX = packRatio * packForce * body.mass;
                if (cx < barMinX) {
                    holdForceX += (barMinX - cx) * FLOAT_BAR.SPRING_STIFFNESS * 0.0006 * body.mass;
                } else if (cx > barMaxX) {
                    holdForceX += (barMaxX - cx) * FLOAT_BAR.SPRING_STIFFNESS * 0.0006 * body.mass;
                }

                Body.applyForce(body, body.position, {
                    x: holdForceX,
                    y: antiGravityY + holdForceY
                });

                // 横方向は極低ダンピング（スルスル滑る）、縦方向は揺れを抑える減衰を適用
                Body.setVelocity(body, {
                    x: body.velocity.x * stepDampX,
                    y: body.velocity.y * stepDampY
                });
            }
        }

        // ==========================================
        // 6. すり抜け・物理爆発防止の最大速度クランプ（SUBSTEPS=4 正規化済み）
        // ==========================================
        for (let j = 0; j < n; j++) {
            const body = particles[j];
            const vx = body.velocity.x;
            const vy = body.velocity.y;
            const speedSq = vx * vx + vy * vy;
            if (speedSq > maxSpeedSq) {
                const scale = maxSpeed / Math.sqrt(speedSq);
                Body.setVelocity(body, {
                    x: vx * scale,
                    y: vy * scale
                });
            }
        }

        // 非侵入排斥ソルバー対象としてバッファへ登録
        activeJelliesBuffer.push(comp);
    }

    // ==========================================
    // 7. ソフトボディ間「非侵入（Anti-Overlap）排斥ソルバー」の実行
    // ==========================================
    solveAntiOverlap(activeJelliesBuffer);
    activeJelliesBuffer.length = 0;
}