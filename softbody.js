/**
 * softbody.js
 * @version v8.5 (Velocity-Linked Weight-Offload, Air-Merge StartLanded Support, Substep Zero-Alloc & Fallback Sync - Phase 4)
 * @changes
 *   - applyVolumeAndShapeForces() へ速度連動ウェイト・オフロード（PHYSICS.SETTLED_FALL_SPEED_START / SETTLED_FALL_SPEED_FULL による下向き落下時のオフロード滑らか解除）を導入し、多層静止時の底層圧潰防止と空洞発生時の爽快な雪崩・大連鎖を両立
 *   - createSoftBodyJelly() へ省略可能パラメータ startLanded（既定値 !isFloating）を追加し、下段空中合体時の未着地状態（空中超液体モード・launchedAt フェイルセーフ）継承に対応
 *   - 毎サブステップ内の一時 { x, y } リテラル（Body.applyForce / Body.setVelocity / Body.setPosition）および computeBodyGeometry() 戻り値オブジェクトを事前確保バッファ（tempForce / tempVec / tempGeom）へ置換し、GC負荷を削減
 *   - フォールバック値を最新定数へ同期（MAX_PARTICLE_VY: 11.0 → 12.0 / TARGET_AREA_RATIO: 0.98 → 1.02 / baseRadius: 21.5 → 24.0）
 * 
 * ソフトボディ（中空ビーズリング剛体）の生成・物理更新モジュール
 * 
 * 中心に剛体コアを持たず、外周の隙間ゼロ細密ビーズリングと柔らかな表面張力・曲げ拘束・
 * 強化非線形バルク内圧・体積粘性・着地後ウェイト・オフロード・分散非侵入排斥により、上段では横長カプセルとして並び、
 * 落下〜着地インパクト直後は超液体のようにたわみ、下段定着後は軽気体バルーンのように
 * 下部へ過度な重みを伝えず縦に立ち上がって体積を保ちつつ周囲へ心地よく波紋を伝える本家sobosuba風の挙動を実現します。
 * 上段フロートバー制御・発射API・2.5Dホップ制御は bar_motion.js へ分離委譲しています。
 * ESM経由でMatter.jsを直接読み込み、起動エラーを防ぎます。
 */

import Matter from 'https://esm.sh/matter-js';
import { PHYSICS, JELLY_CONFIG, FLOAT_BAR, EFFECTS, COLLISION_CATEGORY } from '/sobosuba/constants.js?v=7';
import { clampPointToContainer } from '/sobosuba/physics.js?v=7';
import { solveAntiOverlap } from '/sobosuba/overlap_solver.js?v=7';
import {
    getCollisionMaskForCategory,
    getCapsuleHalfExtentsForValue,
    computeCapsuleRingPoints,
    updateBarGraceState,
    updateBarHopState,
    applyFloatBarControl
} from '/sobosuba/bar_motion.js?v=7';

// 既存呼び出し元（floatbar.js / aim.js / jelly.js）の後方互換を維持するための再エクスポート
export {
    getCapsuleHalfExtentsForValue,
    getSoftBodyHalfExtents,
    launchFloatingJelly,
    launchBarHop
} from '/sobosuba/bar_motion.js?v=7';

const Bodies = Matter.Bodies;
const Composite = Matter.Composite;
const Constraint = Matter.Constraint;
const Body = Matter.Body;

// ゼリーを一意に識別するためのカウンター（合体判定などで使用）
let jellyIdCounter = 0;

// ==========================================
// ゼロアロケーション（毎サブステップGC負荷削減）用独立作業バッファ
// ==========================================
const activeJelliesBuffer = [];
const tempClampPoint = { x: 0, y: 0 };
const tempForce = { x: 0, y: 0 };
const tempVec = { x: 0, y: 0 };
const tempGeom = { cx: 0, cy: 0, vx: 0, vy: 0, signedArea: 0, perimeter: 0 };

/**
 * 閉じた頂点配列の符号付き面積（靴紐の公式）を算出する
 * @param {Array<{ x: number, y: number }>} pts
 * @returns {number}
 */
function computePolygonArea(pts) {
    let area = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        area += (p1.x * p2.y - p2.x * p1.y);
    }
    return Math.abs(area) * 0.5;
}

/**
 * 中空ビーズリング型ソフトボディゼリー（Sobo）を生成する
 * 上段待機（isFloating = true）の場合は横長カプセル形状で生成し、下段では円形リング（既定は即定着耐圧、空中合体時は startLanded = false で未着地継承）で生成する
 * @param {number} x - 生成する中心X座標
 * @param {number} y - 生成する中心Y座標
 * @param {number} value - ゼリーの数値 (1, 2, 4, 8...)
 * @param {Object|null} initialVelocity - 生成時の初速ベクトル {x, y} (無い場合はnull)
 * @param {boolean} isFloating - 上部フロートバー上で無重力浮遊（横長カプセル）させるかどうか
 * @param {boolean} hasMerged - 既に合体に参加済み（スコア加算済み・太字表示）かどうか
 * @param {number} initialScale - 合体時の縮小スポーン開始倍率（通常1.0、合体時0.78等）
 * @param {boolean} [startLanded=!isFloating] - 下段生成時に最初から着地定着済みとして扱うか（空中合体継承時は false）
 * @returns {Matter.Composite} 生成された中空ビーズリングの複合体
 */
export function createSoftBodyJelly(x, y, value, initialVelocity = null, isFloating = false, hasMerged = false, initialScale = 1.0, startLanded = !isFloating) {
    const config = JELLY_CONFIG[value] || JELLY_CONFIG[32768] || JELLY_CONFIG[16384];
    const radius = config.radius;
    const particleCount = Math.max(16, config.particles || 16);

    // 隙間ゼロ高密度・細密シームレス・ビーズリング半径の算出
    // 隣接ビーズ直径 >= BEAD_MIN_OVERLAP_RATIO * 弦長 を数学的に保証する
    const beadRatio = PHYSICS.BEAD_RADIUS_RATIO || 0.18;
    const minOverlap = PHYSICS.BEAD_MIN_OVERLAP_RATIO || 1.35;
    const sinHalf = Math.sin(Math.PI / particleCount);
    const minSeamlessBeadRadius = (minOverlap * sinHalf / (1 + minOverlap * sinHalf)) * radius;
    const particleRadius = Math.max(3.5, radius * beadRatio, minSeamlessBeadRadius);
    const fullRingRadius = Math.max(4, radius - particleRadius);

    // 質量スケーリング（大塊の下敷きによる小塊の圧壊・微振動を防止）
    const baseRadius = (JELLY_CONFIG[1] && JELLY_CONFIG[1].radius) ? JELLY_CONFIG[1].radius : 24.0;
    const densityExp = (PHYSICS.DENSITY_SCALE_EXP !== undefined) ? PHYSICS.DENSITY_SCALE_EXP : 1.45;
    const scaledDensity = (PHYSICS.DENSITY_PARTICLE || 0.0012) * Math.pow(baseRadius / Math.max(baseRadius, radius), densityExp);

    // 小〜中塊（1〜64）下段定着限定の連続耐圧補強因子を算出（128以上は 0.0、ゼロ除算防止ガード付き）
    const refBoostRadius = (PHYSICS.SMALL_BOOST_REF_RADIUS !== undefined) ? PHYSICS.SMALL_BOOST_REF_RADIUS : 58.5;
    const boostSpan = Math.max(1, refBoostRadius - baseRadius);
    const smallBoostFactor = Math.max(0, Math.min(1, (refBoostRadius - radius) / boostSpan));

    // 上段横長カプセル用の外縁寸法とリング中心軌跡を事前算出
    const capExtents = getCapsuleHalfExtentsForValue(value);
    const capRingHalfH = Math.max(3.5, capExtents.halfHeight - particleRadius);
    const capRingStraightHalf = capExtents.straightHalfLength;

    const circleLocalPoints = new Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2;
        circleLocalPoints[i] = {
            x: Math.cos(angle) * fullRingRadius,
            y: Math.sin(angle) * fullRingRadius
        };
    }
    const capsuleLocalPoints = computeCapsuleRingPoints(particleCount, capRingHalfH, capRingStraightHalf);

    // 円形・カプセルそれぞれの隣接バネ長・1つ飛ばし曲げ長・目標面積を事前算出
    const targetAreaRatio = (PHYSICS.TARGET_AREA_RATIO !== undefined) ? PHYSICS.TARGET_AREA_RATIO : 1.02;
    const circleSegmentLength = 2 * fullRingRadius * Math.sin(Math.PI / particleCount);
    const circleBendLength = 2 * fullRingRadius * Math.sin((2 * Math.PI) / particleCount);
    const circleTargetArea = 0.5 * particleCount * fullRingRadius * fullRingRadius * Math.sin((2 * Math.PI) / particleCount) * targetAreaRatio;

    const capsuleSegmentLengths = new Array(particleCount);
    const capsuleBendLengths = new Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
        const pCurr = capsuleLocalPoints[i];
        const pNext1 = capsuleLocalPoints[(i + 1) % particleCount];
        const pNext2 = capsuleLocalPoints[(i + 2) % particleCount];
        capsuleSegmentLengths[i] = Math.hypot(pNext1.x - pCurr.x, pNext1.y - pCurr.y);
        capsuleBendLengths[i] = Math.hypot(pNext2.x - pCurr.x, pNext2.y - pCurr.y);
    }
    const capsuleTargetArea = Math.max(16, computePolygonArea(capsuleLocalPoints) * targetAreaRatio);

    // 合体時「縮小スポーン → Ease-Out-Back 膨張成長（Grow-In）」用の開始スケール設定
    const clampedStartScale = Math.max(0.5, Math.min(1.0, Number(initialScale) || 1.0));
    const isGrowing = clampedStartScale < 0.999;
    const initialShapeBlend = isFloating ? 1.0 : 0.0;
    const initialCategory = isFloating ? COLLISION_CATEGORY.BAR_FLOATING : COLLISION_CATEGORY.FIELD_JELLY;
    const initialMask = getCollisionMaskForCategory(initialCategory);
    const isInitiallyLanded = isFloating ? false : Boolean(startLanded);

    // 上段スポーン時は現行上段剛性を完全保護、下段定着生成時は下段定着耐圧、下段空中合体生成時は空中超液体剛性で初期化
    const airSkin = (PHYSICS.AIR_SKIN_STIFFNESS !== undefined) ? PHYSICS.AIR_SKIN_STIFFNESS : 0.25;
    const airBend = (PHYSICS.AIR_BEND_STIFFNESS !== undefined) ? PHYSICS.AIR_BEND_STIFFNESS : 0.105;
    const settledSkinBase = (PHYSICS.SETTLED_SKIN_STIFFNESS !== undefined) ? PHYSICS.SETTLED_SKIN_STIFFNESS : 0.335;
    const settledBendBase = (PHYSICS.SETTLED_BEND_STIFFNESS !== undefined) ? PHYSICS.SETTLED_BEND_STIFFNESS : 0.135;
    const smallSkinBoost = (PHYSICS.SMALL_SKIN_BOOST !== undefined) ? PHYSICS.SMALL_SKIN_BOOST : 0.065;
    const smallBendBoost = (PHYSICS.SMALL_BEND_BOOST !== undefined) ? PHYSICS.SMALL_BEND_BOOST : 0.095;
    const initialSkinStiffness = isFloating
        ? PHYSICS.SKIN_STIFFNESS
        : (isInitiallyLanded ? (settledSkinBase + smallSkinBoost * smallBoostFactor) : airSkin);
    const initialBendStiffness = isFloating
        ? PHYSICS.BEND_STIFFNESS
        : (isInitiallyLanded ? (settledBendBase + smallBendBoost * smallBoostFactor) : airBend);

    // ソフトボディ全体をまとめるコンポジット（複合体）
    const jellyComposite = Composite.create({ label: 'jelly_composite' });
    const currentJellyId = `jelly_${jellyIdCounter++}`;
    const createdAt = Date.now();

    // 同一ゼリー内のビーズ同士が反発して爆発するのを防ぐ負のコリジョングループ
    const group = Body.nextGroup(true);

    // ==========================================
    // 1. 外周ビーズ剛体（隙間ゼロ細密中空リング：中心コアなし）の生成
    // ==========================================
    const particles = [];
    const spawnPts = isFloating ? capsuleLocalPoints : circleLocalPoints;

    for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2;
        const rawPx = x + spawnPts[i].x * clampedStartScale;
        const rawPy = y + spawnPts[i].y * clampedStartScale;
        const clamped = clampPointToContainer(rawPx, rawPy, particleRadius, tempClampPoint);

        const particle = Bodies.circle(clamped.x, clamped.y, particleRadius, {
            density: scaledDensity,
            friction: PHYSICS.FRICTION,
            frictionStatic: PHYSICS.FRICTION_STATIC,
            frictionAir: PHYSICS.FRICTION_AIR,
            restitution: PHYSICS.RESTITUTION,
            label: 'jelly_particle',
            collisionFilter: {
                group: group,
                category: initialCategory,
                mask: initialMask
            }
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
    // 2. 隣接ビーズ間の皮の張りバネ（柔らかな表面張力）の生成
    // ==========================================
    const skinConstraints = [];
    for (let i = 0; i < particleCount; i++) {
        const p1 = particles[i];
        const p2 = particles[(i + 1) % particleCount];
        const baseSegLen = isFloating ? capsuleSegmentLengths[i] : circleSegmentLength;

        const skinConstraint = Constraint.create({
            bodyA: p1,
            bodyB: p2,
            length: baseSegLen * clampedStartScale,
            stiffness: initialSkinStiffness,
            damping: PHYSICS.SOFTBODY_DAMPING,
            render: { visible: false }
        });
        skinConstraints.push(skinConstraint);
        Composite.add(jellyComposite, skinConstraint);
    }

    // ==========================================
    // 3. 1つ飛ばしビーズ間の適正曲げ拘束（液体変形とフック奇形防止の両立）
    // ==========================================
    const bendConstraints = [];
    for (let i = 0; i < particleCount; i++) {
        const p1 = particles[i];
        const p2 = particles[(i + 2) % particleCount];
        const baseBendLen = isFloating ? capsuleBendLengths[i] : circleBendLength;

        const bendConstraint = Constraint.create({
            bodyA: p1,
            bodyB: p2,
            length: baseBendLen * clampedStartScale,
            stiffness: initialBendStiffness,
            damping: PHYSICS.SOFTBODY_DAMPING,
            render: { visible: false }
        });
        bendConstraints.push(bendConstraint);
        Composite.add(jellyComposite, bendConstraint);
    }

    const baseTargetArea = isFloating ? capsuleTargetArea : circleTargetArea;
    const initHalfW = isFloating ? capExtents.halfWidth : radius;
    const initHalfH = isFloating ? capExtents.halfHeight : radius;
    const initVx = initialVelocity ? (initialVelocity.x || 0) : 0;
    const initVy = initialVelocity ? (initialVelocity.y || 0) : 0;

    // コンポジット自体に高速参照用・物理更新用のメタデータを保持
    jellyComposite.jellyId = currentJellyId;
    jellyComposite.jellyValue = value;
    jellyComposite.isMerging = false;
    jellyComposite.mergePartnerId = null;
    jellyComposite.isFloating = Boolean(isFloating);
    jellyComposite.isBarHopping = false;
    jellyComposite.hopStartTime = 0;
    jellyComposite.hopDirectionX = 0;
    jellyComposite.barGraceActive = false;
    jellyComposite.barGraceStartTime = 0;
    jellyComposite.hasMerged = Boolean(hasMerged);
    jellyComposite.createdAt = createdAt;
    jellyComposite.collisionCategory = initialCategory;
    jellyComposite.particles = particles;
    jellyComposite.skinConstraints = skinConstraints;
    jellyComposite.bendConstraints = bendConstraints;
    jellyComposite.smallBoostFactor = smallBoostFactor;

    // 空中超液体 → 下段定着耐圧ライフサイクル管理状態
    // 下段定着生成時は最初から定着耐圧、上段スポーンおよび下段空中合体生成（startLanded = false）時は未着地で初期化
    jellyComposite.hasLanded = isInitiallyLanded;
    jellyComposite.landedAt = isInitiallyLanded ? createdAt : 0;
    jellyComposite.launchedAt = (!isFloating && !isInitiallyLanded) ? createdAt : 0;
    jellyComposite.landedFirmness = isInitiallyLanded ? 1.0 : 0.0;
    jellyComposite._lastAppliedFirmness = isInitiallyLanded ? 1.0 : 0.0;

    // 形状・サイズ関連メタデータ（円形 ⇔ 横長カプセル両対応）
    jellyComposite.targetRadius = radius;
    jellyComposite.fullRingRadius = fullRingRadius;
    jellyComposite.ringRadius = fullRingRadius * clampedStartScale;
    jellyComposite.particleRadius = particleRadius;
    jellyComposite.capsuleHalfWidth = capExtents.halfWidth;
    jellyComposite.capsuleHalfHeight = capExtents.halfHeight;
    jellyComposite.capsuleRingHalfHeight = capRingHalfH;
    jellyComposite.capsuleRingStraightHalf = capRingStraightHalf;
    jellyComposite.circleLocalPoints = circleLocalPoints;
    jellyComposite.capsuleLocalPoints = capsuleLocalPoints;
    jellyComposite.fullSegmentLength = circleSegmentLength;
    jellyComposite.fullBendLength = circleBendLength;
    jellyComposite.capsuleSegmentLengths = capsuleSegmentLengths;
    jellyComposite.capsuleBendLengths = capsuleBendLengths;
    jellyComposite.fullTargetArea = circleTargetArea;
    jellyComposite.capsuleTargetArea = capsuleTargetArea;
    jellyComposite.targetArea = baseTargetArea * clampedStartScale * clampedStartScale;

    // Grow-In ＆ 形状モーフィング状態
    jellyComposite.isGrowing = isGrowing;
    jellyComposite.growStartScale = clampedStartScale;
    jellyComposite.growDurationMs = EFFECTS.MERGE_GROW_DURATION_MS || 150;
    jellyComposite.growOvershoot = EFFECTS.MERGE_GROW_OVERSHOOT || 1.08;
    jellyComposite.currentGrowScale = clampedStartScale;
    jellyComposite.shapeBlend = initialShapeBlend;
    jellyComposite.isMorphing = false;
    jellyComposite.morphStartBlend = initialShapeBlend;
    jellyComposite.morphTargetBlend = initialShapeBlend;
    jellyComposite.morphStartTime = createdAt;
    jellyComposite.morphDurationMs = FLOAT_BAR.MORPH_DURATION_MS || 160;

    // 幾何状態 ＆ 重心速度 ＆ 遅延適応ダンピング用キャッシュ
    jellyComposite.centroid = { x, y };
    jellyComposite.centroidVel = { x: initVx, y: initVy };
    jellyComposite.lowSpeedMs = 0;
    jellyComposite.avgAngle = 0;
    jellyComposite.aabb = {
        minX: x - initHalfW,
        maxX: x + initHalfW,
        minY: y - initHalfH,
        maxY: y + initHalfH
    };

    // ==========================================
    // 4. 初期速度の付与
    // ==========================================
    if (initialVelocity) {
        tempVec.x = initVx;
        tempVec.y = initVy;
        for (let i = 0; i < particles.length; i++) {
            Body.setVelocity(particles[i], tempVec);
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

// ==========================================
// updateSoftBodies() 用 責務別サブ関数群
// ==========================================

/**
 * サブ関数1：合体時の Ease-Out-Back 膨張成長（Grow-In）、円形⇔横長カプセルモーフィング、
 * および空中超液体 → 下段定着耐圧（landedFirmness）のバネ剛性2段連続補間を更新する
 */
function updateGrowAndMorphConstraints(comp, now) {
    let needsLengthSync = false;
    let needsStiffnessSync = false;
    const isBarState = Boolean(comp.isFloating || comp.isBarHopping);

    // (A) 合体時の縮小スポーン → Ease-Out-Back（オーバーシュート1.08倍）膨張成長
    if (comp.isGrowing) {
        const elapsed = Math.max(0, now - (comp.createdAt || now));
        const duration = Math.max(1, comp.growDurationMs || 150);
        const rawT = Math.min(1, elapsed / duration);
        const startScale = comp.growStartScale || 0.78;
        const overshoot = comp.growOvershoot || 1.08;

        const easeOut = 1 - Math.pow(1 - rawT, 3);
        const baseScale = startScale + (1 - startScale) * easeOut;
        const bounce = (overshoot - 1) * Math.sin(rawT * Math.PI) * rawT * 1.45;
        comp.currentGrowScale = (rawT >= 1) ? 1.0 : (baseScale + bounce);

        if (rawT >= 1) {
            comp.isGrowing = false;
        }
        needsLengthSync = true;
    }

    // (B) 横長カプセル ⇔ 半カプセル ⇔ 円形リングの滑らかなモーフィング補間
    if (comp.isMorphing) {
        const elapsed = Math.max(0, now - (comp.morphStartTime || now));
        const duration = Math.max(1, comp.morphDurationMs || 160);
        const rawT = Math.min(1, elapsed / duration);
        const easedT = 1 - Math.pow(1 - rawT, 3);
        const startB = comp.morphStartBlend || 0;
        const targetB = comp.morphTargetBlend || 0;
        comp.shapeBlend = startB + (targetB - startB) * easedT;

        if (rawT >= 1) {
            comp.shapeBlend = targetB;
            comp.isMorphing = false;
        }
        needsLengthSync = true;
        needsStiffnessSync = true;
    }

    // (C) 空中超液体 → 着地後 180ms ホールド → 420ms Smoothstep ランプによる landedFirmness 更新
    // モーフィング完了後に着地した場合も確実に移行させるため、早期リターンより前に評価する
    if (!isBarState) {
        if (!comp.hasLanded) {
            const failsafeMs = (PHYSICS.LAND_FAILSAFE_MS !== undefined) ? PHYSICS.LAND_FAILSAFE_MS : 2200;
            if (comp.launchedAt > 0 && (now - comp.launchedAt) >= failsafeMs) {
                comp.hasLanded = true;
                comp.landedAt = now;
            }
        }

        if (comp.hasLanded) {
            if (comp.landedFirmness === undefined || comp.landedFirmness < 0.999) {
                const holdMs = (PHYSICS.LAND_SOFT_HOLD_MS !== undefined) ? PHYSICS.LAND_SOFT_HOLD_MS : 180;
                const rampMs = Math.max(1, PHYSICS.LAND_FIRM_RAMP_MS || 420);
                const elapsedLand = Math.max(0, now - (comp.landedAt || now));
                if (elapsedLand <= holdMs) {
                    comp.landedFirmness = 0.0;
                } else {
                    const rawRamp = Math.min(1, (elapsedLand - holdMs) / rampMs);
                    comp.landedFirmness = (rawRamp >= 1) ? 1.0 : (rawRamp * rawRamp * (3 - 2 * rawRamp));
                }
            } else {
                comp.landedFirmness = 1.0;
            }
        } else {
            comp.landedFirmness = 0.0;
        }

        const lastFirm = (comp._lastAppliedFirmness !== undefined) ? comp._lastAppliedFirmness : -1;
        if (Math.abs(comp.landedFirmness - lastFirm) > 0.0005) {
            needsStiffnessSync = true;
        }
    } else if (comp._lastAppliedFirmness !== 0.0) {
        needsStiffnessSync = true;
    }

    if (!needsLengthSync && !needsStiffnessSync) return;

    const curScale = comp.currentGrowScale || 1.0;
    const blend = (comp.shapeBlend !== undefined) ? comp.shapeBlend : (isBarState ? 1 : 0);

    // effectiveBarBlend による2段連続補間（上段待機・ホップ中は 1.0 で完全保護、定着完了後は定常スキップ）
    const effectiveBarBlend = isBarState ? 1.0 : blend;
    const firmness = isBarState ? 0.0 : ((comp.landedFirmness !== undefined) ? comp.landedFirmness : 1.0);
    const smallBoostFactor = comp.smallBoostFactor || 0;

    const airSkin = (PHYSICS.AIR_SKIN_STIFFNESS !== undefined) ? PHYSICS.AIR_SKIN_STIFFNESS : 0.25;
    const airBend = (PHYSICS.AIR_BEND_STIFFNESS !== undefined) ? PHYSICS.AIR_BEND_STIFFNESS : 0.105;
    const settledSkinBase = (PHYSICS.SETTLED_SKIN_STIFFNESS !== undefined) ? PHYSICS.SETTLED_SKIN_STIFFNESS : 0.335;
    const settledBendBase = (PHYSICS.SETTLED_BEND_STIFFNESS !== undefined) ? PHYSICS.SETTLED_BEND_STIFFNESS : 0.135;
    const smallSkinBoost = (PHYSICS.SMALL_SKIN_BOOST !== undefined) ? PHYSICS.SMALL_SKIN_BOOST : 0.065;
    const smallBendBoost = (PHYSICS.SMALL_BEND_BOOST !== undefined) ? PHYSICS.SMALL_BEND_BOOST : 0.095;

    const settledSkin = settledSkinBase + smallSkinBoost * smallBoostFactor;
    const settledBend = settledBendBase + smallBendBoost * smallBoostFactor;
    const fieldSkin = airSkin + (settledSkin - airSkin) * firmness;
    const fieldBend = airBend + (settledBend - airBend) * firmness;
    const syncedSkinStiffness = fieldSkin + (PHYSICS.SKIN_STIFFNESS - fieldSkin) * effectiveBarBlend;
    const syncedBendStiffness = fieldBend + (PHYSICS.BEND_STIFFNESS - fieldBend) * effectiveBarBlend;

    if (needsLengthSync) {
        const circleArea = comp.fullTargetArea || (Math.PI * (comp.fullRingRadius || 16) ** 2);
        const capsuleArea = comp.capsuleTargetArea || circleArea;
        const blendedArea = circleArea + (capsuleArea - circleArea) * blend;
        comp.targetArea = blendedArea * curScale * curScale;
        comp.ringRadius = (comp.fullRingRadius || comp.ringRadius) * curScale;
    }

    const skinCs = comp.skinConstraints;
    const capSegs = comp.capsuleSegmentLengths;
    const circSeg = comp.fullSegmentLength || 10;
    if (skinCs) {
        for (let j = 0; j < skinCs.length; j++) {
            if (needsLengthSync) {
                const capLen = capSegs ? capSegs[j] : circSeg;
                skinCs[j].length = (circSeg + (capLen - circSeg) * blend) * curScale;
            }
            if (needsStiffnessSync) {
                skinCs[j].stiffness = syncedSkinStiffness;
            }
        }
    }

    const bendCs = comp.bendConstraints;
    const capBends = comp.capsuleBendLengths;
    const circBend = comp.fullBendLength || 18;
    if (bendCs) {
        for (let j = 0; j < bendCs.length; j++) {
            if (needsLengthSync) {
                const capLen = capBends ? capBends[j] : circBend;
                bendCs[j].length = (circBend + (capLen - circBend) * blend) * curScale;
            }
            if (needsStiffnessSync) {
                bendCs[j].stiffness = syncedBendStiffness;
            }
        }
    }

    if (needsStiffnessSync) {
        comp._lastAppliedFirmness = isBarState ? 0.0 : firmness;
    }
}

/**
 * サブ関数2：重心・重心速度（comp.centroidVel）・符号付き面積（靴紐の公式）・周長・AABBをインプレース算出する
 * @returns {{ cx: number, cy: number, vx: number, vy: number, signedArea: number, perimeter: number }}
 */
function computeBodyGeometry(comp) {
    const particles = comp.particles;
    const n = particles.length;

    let cx = 0;
    let cy = 0;
    let sumVx = 0;
    let sumVy = 0;
    let signedArea = 0;
    let perimeter = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let j = 0; j < n; j++) {
        const body = particles[j];
        const p1 = body.position;
        const p2 = particles[(j + 1) % n].position;
        cx += p1.x;
        cy += p1.y;
        sumVx += body.velocity.x;
        sumVy += body.velocity.y;

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
    const vx = sumVx / n;
    const vy = sumVy / n;
    signedArea *= 0.5;

    if (!comp.centroid) {
        comp.centroid = { x: cx, y: cy };
    } else {
        comp.centroid.x = cx;
        comp.centroid.y = cy;
    }

    if (!comp.centroidVel) {
        comp.centroidVel = { x: vx, y: vy };
    } else {
        comp.centroidVel.x = vx;
        comp.centroidVel.y = vy;
    }

    if (!comp.aabb) {
        comp.aabb = { minX, maxX, minY, maxY };
    } else {
        comp.aabb.minX = minX;
        comp.aabb.maxX = maxX;
        comp.aabb.minY = minY;
        comp.aabb.maxY = maxY;
    }

    tempGeom.cx = cx;
    tempGeom.cy = cy;
    tempGeom.vx = vx;
    tempGeom.vy = vy;
    tempGeom.signedArea = signedArea;
    tempGeom.perimeter = perimeter;
    return tempGeom;
}

/**
 * サブ関数3：穏健なアンチ裏返り自動修復 OR 軽気体バルーン物理（強化非線形バルク内圧＋体積粘性＋異方性最小距離復元＋速度連動ウェイト・オフロード）
 * ※PBD位置ワープおよび真円形状保持（SHAPE_MATCH）は完全撤廃
 */
function applyVolumeAndShapeForces(comp, geom, gravityY, gravityScale) {
    const particles = comp.particles;
    const n = particles.length;
    const pRadius = comp.particleRadius || 4;
    const ringRadius = comp.ringRadius || 16;
    const targetArea = comp.targetArea || (Math.PI * ringRadius * ringRadius);
    const { cx, cy, vx: centVx, vy: centVy, signedArea } = geom;

    const inversionRatio = (PHYSICS.INVERSION_AREA_RATIO !== undefined) ? PHYSICS.INVERSION_AREA_RATIO : 0.18;
    const barPressure = PHYSICS.SOFTBODY_PRESSURE || 0.00415;
    const nlGain = (PHYSICS.PRESSURE_NONLINEAR_GAIN !== undefined) ? PHYSICS.PRESSURE_NONLINEAR_GAIN : 14.5;
    const nlThreshold = (PHYSICS.PRESSURE_NONLINEAR_THRESHOLD !== undefined) ? PHYSICS.PRESSURE_NONLINEAR_THRESHOLD : 0.055;
    const pressureMax = PHYSICS.PRESSURE_RATIO_MAX || 7.5;
    const barBulkDamping = (PHYSICS.BULK_DAMPING !== undefined) ? PHYSICS.BULK_DAMPING : 0.00086;
    const barMinDistRatio = PHYSICS.SOFTBODY_MIN_DIST_RATIO || 0.78;
    const barRestoreForce = (PHYSICS.MIN_DIST_RESTORE_FORCE !== undefined) ? PHYSICS.MIN_DIST_RESTORE_FORCE : 0.00068;
    const curScale = comp.currentGrowScale || 1.0;

    // (A) 穏健なアンチ裏返り自動修復（面積比0.18未満の極限裏返り時のみ作動）
    if (signedArea < targetArea * inversionRatio) {
        const useCapsule = (comp.isFloating || comp.isBarHopping) && comp.capsuleLocalPoints;
        const baseAngle = useCapsule ? 0 : (comp.avgAngle || 0);
        const cosA = Math.cos(baseAngle);
        const sinA = Math.sin(baseAngle);
        const safeMarginX = useCapsule ? (comp.capsuleHalfWidth || ringRadius) : (pRadius + ringRadius * 0.88);
        const safeMarginY = useCapsule ? (comp.capsuleHalfHeight || ringRadius) : (pRadius + ringRadius * 0.88);
        const safeCenter = clampPointToContainer(cx, cy, Math.min(safeMarginX, safeMarginY), tempClampPoint);
        const safeCx = safeCenter.x;
        const safeCy = safeCenter.y;
        const idealPts = useCapsule ? comp.capsuleLocalPoints : comp.circleLocalPoints;

        for (let j = 0; j < n; j++) {
            const pCurr = particles[j];
            let localX;
            let localY;
            if (idealPts && idealPts[j]) {
                const lx = idealPts[j].x * curScale * 0.9;
                const ly = idealPts[j].y * curScale * 0.9;
                localX = lx * cosA - ly * sinA;
                localY = lx * sinA + ly * cosA;
            } else {
                const idealAngle = baseAngle + (pCurr.initialAngle !== undefined ? pCurr.initialAngle : ((j / n) * Math.PI * 2));
                localX = Math.cos(idealAngle) * ringRadius * 0.88;
                localY = Math.sin(idealAngle) * ringRadius * 0.88;
            }

            const targetX = safeCx + localX;
            const targetY = safeCy + localY;
            const nextX = pCurr.position.x + (targetX - pCurr.position.x) * 0.45;
            const nextY = pCurr.position.y + (targetY - pCurr.position.y) * 0.45;
            const clampedPt = clampPointToContainer(nextX, nextY, pRadius, tempClampPoint);

            Body.setPosition(pCurr, clampedPt);
            tempVec.x = pCurr.velocity.x * 0.55;
            tempVec.y = pCurr.velocity.y * 0.55;
            Body.setVelocity(pCurr, tempVec);
        }
        return;
    }

    // (B) 正常形状時の平均回転角（循環平均）を算出（上段待機・ホップ飛行時は水平0へ穏やかに安定化）
    if (comp.isFloating || comp.isBarHopping) {
        comp.avgAngle *= 0.88;
    } else {
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
    }

    // (C) 強化非線形バルク内圧・体積粘性・異方性最小距離復元・速度連動ウェイト・オフロード（空中超液体 ⇔ 下段定着耐圧 ⇔ 上段保護の2段連続補間）
    const isBarState = Boolean(comp.isFloating || comp.isBarHopping);
    const capRingMinRadius = Math.min(ringRadius, (comp.capsuleRingHalfHeight || ringRadius) * curScale);
    const shapeBlend = (comp.shapeBlend !== undefined)
        ? comp.shapeBlend
        : (isBarState ? 1 : 0);
    const effectiveBarBlend = isBarState ? 1.0 : shapeBlend;
    const firmness = isBarState ? 0.0 : ((comp.landedFirmness !== undefined) ? comp.landedFirmness : 1.0);
    const smallBoostFactor = comp.smallBoostFactor || 0;

    const airPressure = (PHYSICS.AIR_PRESSURE !== undefined) ? PHYSICS.AIR_PRESSURE : 0.0037;
    const airBulkDamping = (PHYSICS.AIR_BULK_DAMPING !== undefined) ? PHYSICS.AIR_BULK_DAMPING : 0.00040;
    const airMinDistRatio = (PHYSICS.AIR_MIN_DIST_RATIO !== undefined) ? PHYSICS.AIR_MIN_DIST_RATIO : 0.64;
    const airRestoreForce = (PHYSICS.AIR_RESTORE_FORCE !== undefined) ? PHYSICS.AIR_RESTORE_FORCE : 0.00028;

    const settledPressureBase = (PHYSICS.SETTLED_PRESSURE !== undefined) ? PHYSICS.SETTLED_PRESSURE : 0.00455;
    const settledBulkDampingBase = (PHYSICS.SETTLED_BULK_DAMPING !== undefined) ? PHYSICS.SETTLED_BULK_DAMPING : 0.00056;
    const settledMinDistBase = (PHYSICS.SETTLED_MIN_DIST_RATIO !== undefined) ? PHYSICS.SETTLED_MIN_DIST_RATIO : 0.800;
    const settledRestoreBase = (PHYSICS.SETTLED_RESTORE_FORCE !== undefined) ? PHYSICS.SETTLED_RESTORE_FORCE : 0.00072;

    const smallPressureMult = (PHYSICS.SMALL_PRESSURE_MULT !== undefined) ? PHYSICS.SMALL_PRESSURE_MULT : 1.02;
    const smallRestoreMult = (PHYSICS.SMALL_RESTORE_MULT !== undefined) ? PHYSICS.SMALL_RESTORE_MULT : 2.0;
    const smallMinDistBoost = (PHYSICS.SMALL_MIN_DIST_RATIO_BOOST !== undefined) ? PHYSICS.SMALL_MIN_DIST_RATIO_BOOST : 0.050;

    const horizMinScale = (PHYSICS.HORIZ_MIN_DIST_SCALE !== undefined) ? PHYSICS.HORIZ_MIN_DIST_SCALE : 0.78;
    const horizRestoreScale = (PHYSICS.HORIZ_RESTORE_SCALE !== undefined) ? PHYSICS.HORIZ_RESTORE_SCALE : 0.40;
    const anisoBlend = 1 - effectiveBarBlend;

    // 速度連動ウェイト・オフロード：下向き落下速度（centVy）が立ち上がるとオフロードを 0% へ滑らかに解除して雪崩・大連鎖テンポを維持（上段待機・ホップ中は isBarState により 0% 完全保護）
    const settledGravScale = (PHYSICS.SETTLED_GRAVITY_SCALE !== undefined) ? PHYSICS.SETTLED_GRAVITY_SCALE : 0.38;
    const fallStart = (PHYSICS.SETTLED_FALL_SPEED_START !== undefined) ? PHYSICS.SETTLED_FALL_SPEED_START : 0.45;
    const fallFull = (PHYSICS.SETTLED_FALL_SPEED_FULL !== undefined) ? PHYSICS.SETTLED_FALL_SPEED_FULL : 1.6;
    let fallOffloadFactor = 1.0;
    if (centVy > fallStart) {
        if (centVy >= fallFull) {
            fallOffloadFactor = 0.0;
        } else {
            const rawFallT = (centVy - fallStart) / Math.max(0.01, fallFull - fallStart);
            fallOffloadFactor = 1.0 - (rawFallT * rawFallT * (3 - 2 * rawFallT));
        }
    }
    const buoyancyRatio = (!isBarState && gravityY && gravityScale && fallOffloadFactor > 0.0001)
        ? Math.max(0, (1 - settledGravScale) * firmness * (1 - effectiveBarBlend) * fallOffloadFactor)
        : 0;
    const offloadAccelY = (buoyancyRatio > 0.0001)
        ? (gravityY * gravityScale * buoyancyRatio)
        : 0;

    const settledPressureMult = 1 + (smallPressureMult - 1) * smallBoostFactor;
    const settledRestoreMult = 1 + (smallRestoreMult - 1) * smallBoostFactor;
    const settledPressure = settledPressureBase * settledPressureMult;
    const settledBulkDamping = settledBulkDampingBase * settledPressureMult;
    const settledMinDistRatio = settledMinDistBase + smallMinDistBoost * smallBoostFactor;
    const settledRestoreForce = settledRestoreBase * settledRestoreMult;

    const fieldPressure = airPressure + (settledPressure - airPressure) * firmness;
    const fieldBulkDamping = airBulkDamping + (settledBulkDamping - airBulkDamping) * firmness;
    const fieldMinDistRatio = airMinDistRatio + (settledMinDistRatio - airMinDistRatio) * firmness;
    const fieldRestoreForce = airRestoreForce + (settledRestoreForce - airRestoreForce) * firmness;

    const effectivePressureCoeff = fieldPressure + (barPressure - fieldPressure) * effectiveBarBlend;
    const effectiveBulkDamping = fieldBulkDamping + (barBulkDamping - fieldBulkDamping) * effectiveBarBlend;
    const effectiveMinDistRatio = fieldMinDistRatio + (barMinDistRatio - fieldMinDistRatio) * effectiveBarBlend;
    const effectiveMinDistRestoreForce = fieldRestoreForce + (barRestoreForce - fieldRestoreForce) * effectiveBarBlend;

    const compression = (targetArea - signedArea) / Math.max(1, targetArea);
    let effectiveRatio = compression;
    if (compression > nlThreshold) {
        const excess = compression - nlThreshold;
        effectiveRatio = compression + excess * excess * nlGain;
    }
    if (effectiveRatio > pressureMax) effectiveRatio = pressureMax;
    else if (effectiveRatio < -0.8) effectiveRatio = -0.8;

    const pressureStrength = effectiveRatio * effectivePressureCoeff * 5.0;

    const effectiveMinRadius = ringRadius + (capRingMinRadius - ringRadius) * shapeBlend;
    const minDist = effectiveMinRadius * effectiveMinDistRatio;

    for (let j = 0; j < n; j++) {
        const pPrev = particles[(j - 1 + n) % n].position;
        const pCurr = particles[j];
        const pNext = particles[(j + 1) % n].position;

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

        // 時計回り閉曲線の幾何学的外向き法線 (ty, -tx) を一貫採用（凹み変形時の法線反転バグを根絶）
        const tx = pNext.x - pPrev.x;
        const ty = pNext.y - pPrev.y;
        const tLen = Math.sqrt(tx * tx + ty * ty);

        let nx = radialX;
        let ny = radialY;
        if (tLen > 0.0001) {
            nx = ty / tLen;
            ny = -tx / tLen;
        }

        // 1. 力ベース強化非線形バルク内圧
        let forceX = nx * pressureStrength * pCurr.mass;
        let forceY = ny * pressureStrength * pCurr.mass;

        // 2. 体積粘性（BULK_DAMPING）：重心速度（飛行・滑り）を阻害せず半径方向ビビリ振動のみ吸収
        if (effectiveBulkDamping > 0) {
            const relVx = pCurr.velocity.x - centVx;
            const relVy = pCurr.velocity.y - centVy;
            const vn = relVx * nx + relVy * ny;
            const dampForce = -vn * effectiveBulkDamping * pCurr.mass;
            forceX += nx * dampForce;
            forceY += ny * dampForce;
        }

        // 3. 異方性最小距離復元（上段待機・ホップ中は anisoBlend=0 で等方維持、下段は縦保護・横自由で縦立ち上がりを解放）
        const wy = radialY * radialY;
        const dirMinScale = 1 + ((horizMinScale + (1 - horizMinScale) * wy) - 1) * anisoBlend;
        const dirMinDist = minDist * dirMinScale;
        if (dist < dirMinDist) {
            const dirRestoreScale = 1 + ((horizRestoreScale + (1 - horizRestoreScale) * wy) - 1) * anisoBlend;
            const overlap = dirMinDist - dist;
            const restoreMag = overlap * effectiveMinDistRestoreForce * dirRestoreScale * pCurr.mass;
            forceX += radialX * restoreMag;
            forceY += radialY * restoreMag;
        }

        // 4. 速度連動ウェイト・オフロード（静止定着した塊の自重の一部を相殺し、下部・小塊への荷重伝達を大幅カット）
        if (offloadAccelY > 0) {
            forceY -= offloadAccelY * pCurr.mass;
        }

        tempForce.x = forceX;
        tempForce.y = forceY;
        Body.applyForce(pCurr, pCurr.position, tempForce);
    }
}

/**
 * サブ関数4：衝撃波打ち連動解放 ＆ 遅延ランプアップ型「適応的圧迫ダンピング」（面積歪み復元保護・着地定着保護付き）
 * 空中落下中・定着遷移中・衝撃波打ち中は連動揺れを無傷で保護し、
 * 下段で形状が復元しきって全体が静止（< 0.28 px/frame）し続けた場合のみ
 * 650ms → 1300ms へ滑らかに重心相対速度（内部微振動）を減衰させてピタッと静寂化する
 */
function applyAdaptiveSettleDamping(comp, geom, subDeltaMs, substeps) {
    if (comp.isFloating || comp.isBarHopping || comp.isGrowing ||
        !comp.hasLanded || (comp.landedFirmness !== undefined && comp.landedFirmness < 0.999)) {
        comp.lowSpeedMs = 0;
        return;
    }

    // 面積歪みが大きい復元途中は減衰させず奇形凍結を防止（底層の正常圧縮 10〜14% は静寂化対象へ含める）
    const targetArea = comp.targetArea || (Math.PI * (comp.ringRadius || 16) * (comp.ringRadius || 16));
    const areaRatio = geom.signedArea / Math.max(1, targetArea);
    if (Math.abs(1 - areaRatio) > 0.20) {
        comp.lowSpeedMs = 0;
        return;
    }

    const speedThresh = PHYSICS.SETTLE_SPEED_THRESHOLD || 0.28;
    const centVx = geom.vx;
    const centVy = geom.vy;
    const centSpeedSq = centVx * centVx + centVy * centVy;

    if (centSpeedSq >= speedThresh * speedThresh) {
        comp.lowSpeedMs = 0;
        return;
    }

    // 周囲から衝撃波を受けて表面が波打ち始めた場合のみ静寂化を一時解除（通常ジッターは無視）
    const particles = comp.particles;
    const n = particles.length;
    const relWaveThresh = (PHYSICS.SETTLE_REL_WAVE_THRESHOLD !== undefined) ? PHYSICS.SETTLE_REL_WAVE_THRESHOLD : 0.48;
    let sumRelSpeedSq = 0;
    for (let j = 0; j < n; j++) {
        const body = particles[j];
        const rvx = body.velocity.x - centVx;
        const rvy = body.velocity.y - centVy;
        sumRelSpeedSq += rvx * rvx + rvy * rvy;
    }
    const avgRelSpeedSq = sumRelSpeedSq / n;
    if (avgRelSpeedSq >= relWaveThresh * relWaveThresh) {
        comp.lowSpeedMs = 0;
        return;
    }

    comp.lowSpeedMs = (comp.lowSpeedMs || 0) + subDeltaMs;

    const delayMs = (PHYSICS.SETTLE_DELAY_MS !== undefined) ? PHYSICS.SETTLE_DELAY_MS : 650;
    if (comp.lowSpeedMs < delayMs) return;

    const rampMs = Math.max(1, PHYSICS.SETTLE_RAMP_MS || 650);
    const rampT = Math.min(1, (comp.lowSpeedMs - delayMs) / rampMs);
    const maxFrameDamp = PHYSICS.SETTLE_MAX_DAMPING || 0.86;
    const frameDamp = 1 - (1 - maxFrameDamp) * rampT;
    const stepRelDamp = Math.pow(frameDamp, 1 / substeps);

    for (let j = 0; j < n; j++) {
        const body = particles[j];
        const relVx = body.velocity.x - centVx;
        const relVy = body.velocity.y - centVy;
        tempVec.x = centVx + relVx * stepRelDamp;
        tempVec.y = centVy + relVy * stepRelDamp;
        Body.setVelocity(body, tempVec);
    }
}

/**
 * サブ関数5：すり抜け・物理爆発防止 ＆ 横失速根絶のX/Y独立最大速度クランプ（SUBSTEPS=4 正規化済み）
 */
function clampParticleVelocities(comp, maxVx, maxVy) {
    const particles = comp.particles;
    const n = particles.length;
    for (let j = 0; j < n; j++) {
        const body = particles[j];
        const vx = body.velocity.x;
        const vy = body.velocity.y;
        let clampedVx = vx;
        let clampedVy = vy;
        let changed = false;

        if (vx > maxVx) {
            clampedVx = maxVx;
            changed = true;
        } else if (vx < -maxVx) {
            clampedVx = -maxVx;
            changed = true;
        }

        if (vy > maxVy) {
            clampedVy = maxVy;
            changed = true;
        } else if (vy < -maxVy) {
            clampedVy = -maxVy;
            changed = true;
        }

        if (changed) {
            tempVec.x = clampedVx;
            tempVec.y = clampedVy;
            Body.setVelocity(body, tempVec);
        }
    }
}

/**
 * 毎サブステップ呼び出されるソフトボディ物理更新関数
 * @param {Matter.World} world - Matter.jsの物理世界
 * @param {Matter.Engine} engine - Matter.jsのエンジン
 * @param {number} [subDeltaMs] - 1サブステップあたりの経過時間（ms、省略時は 60FPS/SUBSTEPS 基準）
 */
export function updateSoftBodies(world, engine, subDeltaMs) {
    if (!world || !engine) return;

    // 毎サブステップの配列新規生成（GC負荷）を避けるため world.composites を直接走査
    const composites = world.composites || [];
    const gravityY = engine.gravity.y;
    const gravityScale = engine.gravity.scale;
    const substeps = Math.max(1, PHYSICS.SUBSTEPS || 4);
    const safeSubDeltaMs = (typeof subDeltaMs === 'number' && subDeltaMs > 0)
        ? subDeltaMs
        : ((1000 / 60) / substeps);
    const maxVx = PHYSICS.MAX_PARTICLE_VX || 10.5;
    const maxVy = PHYSICS.MAX_PARTICLE_VY || 12.0;

    // 1フレームあたりの減衰率をサブステップ回数に応じて等価変換
    const stepDampX = Math.pow(FLOAT_BAR.X_DAMPING || 0.986, 1 / substeps);
    const stepDampY = Math.pow(FLOAT_BAR.Y_DAMPING || 0.945, 1 / substeps);

    const now = Date.now();
    activeJelliesBuffer.length = 0;

    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (!comp || comp.label !== 'jelly_composite') continue;

        const particles = comp.particles;
        if (!particles || particles.length < 3) continue;

        // 1. 合体成長（Ease-Out-Back Grow-In）・カプセル⇔円形モーフィング・空中超液体→下段定着耐圧の更新
        updateGrowAndMorphConstraints(comp, now);

        // 2. 重心・重心速度・符号付き面積・周長・AABBの算出
        const geom = computeBodyGeometry(comp);

        // 2.5 斜め下ショットすり抜け保護（AABB完全離脱検知による即解除・bar_motion.js 委譲）
        updateBarGraceState(comp, composites, now);

        // 3. 穏健なアンチ裏返り修復 / 強化非線形バルク内圧・体積粘性・異方性最小距離復元・速度連動ウェイト・オフロードの適用
        applyVolumeAndShapeForces(comp, geom, gravityY, gravityScale);

        // 4. 天井非激突 2.5D上段飛び越えホップ（半カプセル水平安定 ＆ 進行方向優先セーフ・リキャッチ・bar_motion.js 委譲）
        updateBarHopState(comp, geom, composites, now, gravityY, gravityScale);

        // 5. 上段フロートバー上の無重力フック・柔らかな上下レール圧縮・低減衰スライド（bar_motion.js 委譲）
        applyFloatBarControl(comp, geom.cx, geom.cy, gravityY, gravityScale, stepDampX, stepDampY);

        // 5.5 衝撃波打ち連動解放 ＆ 遅延ランプアップ型「適応的圧迫ダンピング」（面積歪み復元保護・着地定着保護付き静寂化）
        applyAdaptiveSettleDamping(comp, geom, safeSubDeltaMs, substeps);

        // 6. 全ビーズのX/Y独立最大速度クランプ
        clampParticleVelocities(comp, maxVx, maxVy);

        // 分散非侵入排斥ソルバー対象としてバッファへ登録
        activeJelliesBuffer.push(comp);
    }

    // 7. ソフトボディ間「非侵入（Anti-Overlap）排斥ソルバー」を overlap_solver.js へ委譲実行
    solveAntiOverlap(activeJelliesBuffer);
    activeJelliesBuffer.length = 0;
}