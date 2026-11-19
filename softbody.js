/**
 * softbody.js
 * @version v7.2 (Upper Bar Fluidity & Posture Guide Relaxation - Phase 2)
 * @changes
 *   - 上段フロートバー上の塊にぷるんとした液体感とたわみを取り戻すため、applyFloatBarControl() の理想カプセル座標へのX方向強制力を撤廃し、Y方向姿勢ガイドを極弱（0.00032 → 0.00006）へ緩和
 *   - 上下レール圧縮（CHANNEL_COMPRESSION_STIFFNESS: 0.055）および縦方向減衰（FLOAT_BAR.Y_DAMPING: 0.945）のフォールバック値を v7.2 新定数へ同期
 * 
 * ソフトボディ（中空ビーズリング剛体）の生成・物理更新モジュール
 * 
 * 中心に剛体コアを持たず、外周の隙間ゼロ細密ビーズリングと柔らかな表面張力・曲げ拘束・
 * 強化非線形バルク内圧・体積粘性・分散非侵入排斥により、上段では横長カプセルとして並び、
 * 下段では液体のように角まで流れ込んで静かに密着する本家sobosuba風の挙動を実現します。
 * ESM経由でMatter.jsを直接読み込み、起動エラーを防ぎます。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, PHYSICS, JELLY_CONFIG, FLOAT_BAR, EFFECTS, CONTAINER, COLLISION_CATEGORY } from '/sobosuba/constants.js?v=7';
import { clampPointToContainer } from '/sobosuba/physics.js?v=7';
import { solveAntiOverlap } from '/sobosuba/overlap_solver.js?v=7';

const Bodies = Matter.Bodies;
const Composite = Matter.Composite;
const Constraint = Matter.Constraint;
const Body = Matter.Body;

// ゼリーを一意に識別するためのカウンター（合体判定などで使用）
let jellyIdCounter = 0;

// ==========================================
// 衝突マスク定義（2.5D飛び越えレーン・斜め下すり抜け保護・バンパー誤爆ゼロ）
// ==========================================
const MASK_FIELD_JELLY =
    COLLISION_CATEGORY.WALL |
    COLLISION_CATEGORY.BUMPER |
    COLLISION_CATEGORY.FIELD_JELLY |
    COLLISION_CATEGORY.BAR_FLOATING;

// 斜め下ショット直後の隣カプセル角すり抜け保護用マスク（BAR_FLOATING のみ一時除外）
const MASK_FIELD_JELLY_GRACE =
    COLLISION_CATEGORY.WALL |
    COLLISION_CATEGORY.BUMPER |
    COLLISION_CATEGORY.FIELD_JELLY;

const MASK_BAR_FLOATING =
    COLLISION_CATEGORY.WALL |
    COLLISION_CATEGORY.FIELD_JELLY |
    COLLISION_CATEGORY.BAR_FLOATING;

const MASK_BAR_HOPPING = COLLISION_CATEGORY.WALL;

// ==========================================
// ゼロアロケーション（毎サブステップGC負荷削減）用作業バッファ
// ==========================================
const activeJelliesBuffer = [];
const tempClampPoint = { x: 0, y: 0 };

/**
 * 状態カテゴリに応じた標準衝突マスクを返す
 * @param {number} category - COLLISION_CATEGORY のビット値
 * @returns {number} 衝突マスク
 */
function getCollisionMaskForCategory(category) {
    if (category === COLLISION_CATEGORY.BAR_HOPPING) return MASK_BAR_HOPPING;
    if (category === COLLISION_CATEGORY.BAR_FLOATING) return MASK_BAR_FLOATING;
    return MASK_FIELD_JELLY;
}

/**
 * ソフトボディ内の全ビーズ剛体の衝突カテゴリ・マスクを一括切替する
 * @param {Matter.Composite} comp - 対象のゼリーコンポジット
 * @param {number} category - 切替先の COLLISION_CATEGORY
 * @param {number|null} [customMask=null] - 明示指定マスク（省略時はカテゴリ標準マスク）
 */
function setSoftBodyCollisionCategory(comp, category, customMask = null) {
    if (!comp || !comp.particles) return;
    const mask = (customMask !== null && customMask !== undefined)
        ? customMask
        : getCollisionMaskForCategory(category);
    const particles = comp.particles;
    for (let i = 0; i < particles.length; i++) {
        particles[i].collisionFilter.category = category;
        particles[i].collisionFilter.mask = mask;
    }
    comp.collisionCategory = category;
}

/**
 * 指定された数値のゼリーが上段フロートバー上で取る「横長カプセル」の外縁半幅・半高を算出する
 * （floatbar.js の出現前クリアランス検知・初期配置と、softbody.js のカプセル生成で共有）
 * @param {number} value - ゼリーの数値
 * @returns {{ halfWidth: number, halfHeight: number, straightHalfLength: number }}
 */
export function getCapsuleHalfExtentsForValue(value) {
    const config = JELLY_CONFIG[value] || JELLY_CONFIG[32768] || JELLY_CONFIG[16384];
    const radius = config ? config.radius : 21.5;
    const channelHalfH = FLOAT_BAR.CHANNEL_HALF_HEIGHT || 22;
    const maxHalfW = FLOAT_BAR.CAPSULE_MAX_HALF_WIDTH || 110;

    // 面積保存（pi * R^2 = pi * H^2 + 4 * H * L）で高さ2Hに収めた横長カプセルの直線半長Lを算出
    const halfHeight = Math.min(radius, channelHalfH);
    const straightHalfLength = (radius > halfHeight && halfHeight > 0)
        ? Math.max(0, (Math.PI * (radius * radius - halfHeight * halfHeight)) / (4 * halfHeight))
        : 0;
    const halfWidth = Math.min(maxHalfW, halfHeight + straightHalfLength);
    const clampedStraightHalf = Math.max(0, halfWidth - halfHeight);

    return {
        halfWidth,
        halfHeight,
        straightHalfLength: clampedStraightHalf
    };
}

/**
 * カプセル（スタジアム形状）のリング中心軌跡上に N 個のビーズ座標を時計回りで等弧長配置する
 * （角度 0 = 右端から時計回り配置とし、円形リングと頂点インデックス対応を100%一致させる）
 * @param {number} n - ビーズ数
 * @param {number} hRing - リング中心軌跡の半高
 * @param {number} lRing - リング中心軌跡の直線半長
 * @returns {Array<{ x: number, y: number }>}
 */
function computeCapsuleRingPoints(n, hRing, lRing) {
    const points = new Array(n);
    const safeH = Math.max(3, hRing);
    const safeL = Math.max(0, lRing);

    // 直線半長がほぼ0なら真円と同一配置
    if (safeL < 0.05) {
        for (let i = 0; i < n; i++) {
            const angle = (i / n) * Math.PI * 2;
            points[i] = {
                x: Math.cos(angle) * safeH,
                y: Math.sin(angle) * safeH
            };
        }
        return points;
    }

    const qArc = 0.5 * Math.PI * safeH;  // クォーター円弧長
    const straightLen = 2 * safeL;       // 上下それぞれの直線長
    const hArc = Math.PI * safeH;        // 左半円弧長
    const perimeter = 2 * Math.PI * safeH + 4 * safeL;

    const s1 = qArc;                     // 右下クォーター終端
    const s2 = s1 + straightLen;         // 下直線終端
    const s3 = s2 + hArc;                // 左半円終端
    const s4 = s3 + straightLen;         // 上直線終端

    for (let i = 0; i < n; i++) {
        const s = (i / n) * perimeter;
        let px = 0;
        let py = 0;

        if (s < s1) {
            const phi = (s / qArc) * (Math.PI * 0.5);
            px = safeL + safeH * Math.cos(phi);
            py = safeH * Math.sin(phi);
        } else if (s < s2) {
            const u = (s - s1) / straightLen;
            px = safeL - straightLen * u;
            py = safeH;
        } else if (s < s3) {
            const phi = Math.PI * 0.5 + ((s - s2) / hArc) * Math.PI;
            px = -safeL + safeH * Math.cos(phi);
            py = safeH * Math.sin(phi);
        } else if (s < s4) {
            const u = (s - s3) / straightLen;
            px = -safeL + straightLen * u;
            py = -safeH;
        } else {
            const phi = Math.PI * 1.5 + ((s - s4) / qArc) * (Math.PI * 0.5);
            px = safeL + safeH * Math.cos(phi);
            py = safeH * Math.sin(phi);
        }

        points[i] = { x: px, y: py };
    }

    return points;
}

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
 * 形状モーフィング（円形 0.0 ⇔ 横長カプセル 1.0）を開始する
 * @param {Matter.Composite} comp
 * @param {number} targetBlend - 目標ブレンド値（0.0=円形, 0.5=半カプセル, 1.0=横長カプセル）
 * @param {number} durationMs - モーフィング時間（ms）
 * @param {number} now - 現在時刻（ms）
 */
function startShapeMorph(comp, targetBlend, durationMs, now) {
    if (!comp) return;
    comp.morphStartBlend = (comp.shapeBlend !== undefined) ? comp.shapeBlend : (comp.isFloating ? 1 : 0);
    comp.morphTargetBlend = Math.max(0, Math.min(1, targetBlend));
    comp.morphStartTime = now;
    comp.morphDurationMs = Math.max(1, durationMs || 160);
    comp.isMorphing = Math.abs(comp.morphTargetBlend - comp.morphStartBlend) > 0.001;
    if (!comp.isMorphing) {
        comp.shapeBlend = comp.morphTargetBlend;
    }
}

/**
 * コンポジット全体の全ビーズを指定量 (shiftX, shiftY) だけ安全シフトする（セーフ・リキャッチ用）
 * @param {Matter.Composite} comp
 * @param {number} shiftX
 * @param {number} [shiftY=0]
 */
function shiftSoftBody(comp, shiftX, shiftY = 0) {
    if (!comp || !comp.particles || (Math.abs(shiftX) < 0.05 && Math.abs(shiftY) < 0.05)) return;
    const particles = comp.particles;
    const pRadius = comp.particleRadius || 4;
    let sumX = 0;
    let sumY = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const clamped = clampPointToContainer(
            p.position.x + shiftX,
            p.position.y + shiftY,
            pRadius,
            tempClampPoint
        );
        Body.setPosition(p, { x: clamped.x, y: clamped.y });
        sumX += clamped.x;
        sumY += clamped.y;
        if (clamped.x < minX) minX = clamped.x;
        if (clamped.x > maxX) maxX = clamped.x;
        if (clamped.y < minY) minY = clamped.y;
        if (clamped.y > maxY) maxY = clamped.y;
    }

    const n = particles.length;
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
 * 中空ビーズリング型ソフトボディゼリー（Sobo）を生成する
 * 上段待機（isFloating = true）の場合は横長カプセル形状で生成し、下段では円形リングで生成する
 * @param {number} x - 生成する中心X座標
 * @param {number} y - 生成する中心Y座標
 * @param {number} value - ゼリーの数値 (1, 2, 4, 8...)
 * @param {Object|null} initialVelocity - 生成時の初速ベクトル {x, y} (無い場合はnull)
 * @param {boolean} isFloating - 上部フロートバー上で無重力浮遊（横長カプセル）させるかどうか
 * @param {boolean} hasMerged - 既に合体に参加済み（スコア加算済み・太字表示）かどうか
 * @param {number} initialScale - 合体時の縮小スポーン開始倍率（通常1.0、合体時0.78等）
 * @returns {Matter.Composite} 生成された中空ビーズリングの複合体
 */
export function createSoftBodyJelly(x, y, value, initialVelocity = null, isFloating = false, hasMerged = false, initialScale = 1.0) {
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

    // 質量スケーリング（r^1.35 相当：大塊の下敷きによる小塊の圧壊・微振動を防止）
    const baseRadius = (JELLY_CONFIG[1] && JELLY_CONFIG[1].radius) ? JELLY_CONFIG[1].radius : 21.5;
    const densityExp = (PHYSICS.DENSITY_SCALE_EXP !== undefined) ? PHYSICS.DENSITY_SCALE_EXP : 0.65;
    const scaledDensity = (PHYSICS.DENSITY_PARTICLE || 0.0012) * Math.pow(baseRadius / Math.max(baseRadius, radius), densityExp);

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

    // 円形・カプセルそれぞれの隣接バネ長・1つ飛ばし曲げ長・目標面積（0.98倍）を事前算出
    const targetAreaRatio = (PHYSICS.TARGET_AREA_RATIO !== undefined) ? PHYSICS.TARGET_AREA_RATIO : 0.98;
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
            stiffness: PHYSICS.SKIN_STIFFNESS,
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
            stiffness: PHYSICS.BEND_STIFFNESS,
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
        for (let i = 0; i < particles.length; i++) {
            Body.setVelocity(particles[i], { x: initVx, y: initVy });
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
 * 対象ゼリーの現在の実効半幅・半高（横長カプセル対応）を取得する
 * floatbar.js のクリアランス検知および aim.js の横長タップ判定で使用
 * @param {Matter.Composite} jellyComposite - 対象のゼリーコンポジット
 * @returns {{ halfWidth: number, halfHeight: number }}
 */
export function getSoftBodyHalfExtents(jellyComposite) {
    if (!jellyComposite) {
        return { halfWidth: 21.5, halfHeight: 21.5 };
    }

    const r = jellyComposite.targetRadius || 21.5;
    const capW = jellyComposite.capsuleHalfWidth || r;
    const capH = jellyComposite.capsuleHalfHeight || r;
    const blend = (jellyComposite.shapeBlend !== undefined)
        ? jellyComposite.shapeBlend
        : (jellyComposite.isFloating ? 1 : 0);

    // 現在のモーフィング比率から理想外縁の半幅・半高を算出
    let halfWidth = r + (capW - r) * blend;
    let halfHeight = r + (capH - r) * blend;

    // 物理AABBが大きく変形している場合は実外縁幅も反映（タップ取りこぼし・重なり防止）
    if (jellyComposite.aabb) {
        const pRadius = jellyComposite.particleRadius || 4;
        const aabbHalfW = (jellyComposite.aabb.maxX - jellyComposite.aabb.minX) * 0.5 + pRadius;
        const aabbHalfH = (jellyComposite.aabb.maxY - jellyComposite.aabb.minY) * 0.5 + pRadius;
        if (isFinite(aabbHalfW) && aabbHalfW > 0) {
            halfWidth = Math.max(halfWidth * 0.85, Math.min(halfWidth * 1.25, aabbHalfW));
        }
        if (isFinite(aabbHalfH) && aabbHalfH > 0) {
            halfHeight = Math.max(halfHeight * 0.85, Math.min(halfHeight * 1.25, aabbHalfH));
        }
    }

    return { halfWidth, halfHeight };
}

/**
 * フロートバー上のゼリーを無重力状態から解除し、現在の移動速度に加算（Additive Momentum）して下段へ発射する
 * 斜め下ショット（useBarGrace = true）時は全 BAR_FLOATING との AABB 離脱まで一時的に隣カプセル衝突を免除する
 * @param {Matter.Composite} jellyComposite - 発射するゼリーのコンポジット
 * @param {Object} addVelocity - 加算する発射速度ベクトル {x, y}（そっと落とし時は {x: 0, y: 0}）
 * @param {boolean} [useBarGrace=false] - 斜め下ショット時の隣カプセル角すり抜け保護を有効にするか
 */
export function launchFloatingJelly(jellyComposite, addVelocity = { x: 0, y: 0 }, useBarGrace = false) {
    if (!jellyComposite) return;
    const now = Date.now();
    jellyComposite.isFloating = false;
    jellyComposite.isBarHopping = false;
    jellyComposite.hopStartTime = 0;
    jellyComposite.hopDirectionX = 0;
    jellyComposite.lowSpeedMs = 0;

    // 斜め下ショット限定すり抜け保護（AABB完全離脱で即解除、安全上限220ms）
    if (useBarGrace) {
        jellyComposite.barGraceActive = true;
        jellyComposite.barGraceStartTime = now;
        setSoftBodyCollisionCategory(jellyComposite, COLLISION_CATEGORY.FIELD_JELLY, MASK_FIELD_JELLY_GRACE);
    } else {
        jellyComposite.barGraceActive = false;
        jellyComposite.barGraceStartTime = 0;
        setSoftBodyCollisionCategory(jellyComposite, COLLISION_CATEGORY.FIELD_JELLY, MASK_FIELD_JELLY);
    }

    // 円形スライムへのモーフィング開始（変身の間）
    startShapeMorph(jellyComposite, 0.0, FLOAT_BAR.MORPH_DURATION_MS || 160, now);

    const particles = jellyComposite.particles;
    if (!particles || particles.length === 0) return;

    const addX = addVelocity ? (addVelocity.x || 0) : 0;
    const addY = addVelocity ? (addVelocity.y || 0) : 0;
    const maxVx = PHYSICS.MAX_PARTICLE_VX || 10.5;
    const maxVy = PHYSICS.MAX_PARTICLE_VY || 11.0;

    let sumVx = 0;
    let sumVy = 0;

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        // 本家v1.2準拠：バー上での横移動速度を保持したまま発射ベクトルを加算し、X/Y独立クランプで横失速を根絶
        const vx = Math.max(-maxVx, Math.min(maxVx, p.velocity.x + addX));
        const vy = Math.max(-maxVy, Math.min(maxVy, p.velocity.y + addY));

        Body.setVelocity(p, { x: vx, y: vy });
        sumVx += vx;
        sumVy += vy;
    }

    // 発射直後の衝突音判定用に重心速度キャッシュも即同期
    const n = particles.length;
    if (!jellyComposite.centroidVel) {
        jellyComposite.centroidVel = { x: sumVx / n, y: sumVy / n };
    } else {
        jellyComposite.centroidVel.x = sumVx / n;
        jellyComposite.centroidVel.y = sumVy / n;
    }
}

/**
 * 上段フロートバーのゼリーを「天井非激突・2.5D飛び越えレーン方式」の上段ホップ（Bar-Hop）状態で発射する
 * BAR_HOPPING カテゴリへ切替し、飛行中は半カプセル（shapeBlend: 0.5）の水平姿勢を保って確実に飛び越える
 * @param {Matter.Composite} jellyComposite - ホップさせるゼリーのコンポジット
 * @param {Object} hopVelocity - ホップ初速ベクトル {x, y}（px/frame 単位）
 */
export function launchBarHop(jellyComposite, hopVelocity = { x: 0, y: -5.80 }) {
    if (!jellyComposite) return;
    const now = Date.now();
    jellyComposite.isFloating = false;
    jellyComposite.isBarHopping = true;
    jellyComposite.hopStartTime = now;
    jellyComposite.barGraceActive = false;
    jellyComposite.barGraceStartTime = 0;
    jellyComposite.lowSpeedMs = 0;

    // 2.5D飛び越えレーン用衝突カテゴリ（壁・天井のみ反射）へ切替 ＆ 半カプセル（0.5）維持で天井非激突を保証
    setSoftBodyCollisionCategory(jellyComposite, COLLISION_CATEGORY.BAR_HOPPING);
    startShapeMorph(jellyComposite, 0.5, FLOAT_BAR.MORPH_DURATION_MS || 160, now);

    const particles = jellyComposite.particles;
    if (!particles || particles.length === 0) return;

    const hopX = hopVelocity ? (hopVelocity.x || 0) : 0;
    const hopY = hopVelocity ? (hopVelocity.y || 0) : -5.80;
    const inheritVx = (FLOAT_BAR.HOP_INHERIT_VX !== undefined) ? FLOAT_BAR.HOP_INHERIT_VX : 0.2;
    const maxHopSpeed = FLOAT_BAR.HOP_MAX_SPEED || 11.5;
    const maxHopSpeedSq = maxHopSpeed * maxHopSpeed;

    let sumVx = 0;
    let sumVy = 0;

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        // 予測ドットと一致させるためバー上横速度は控えめ（0.2倍）に継承し、Y速度はホップ初速を採用
        let vx = p.velocity.x * inheritVx + hopX;
        let vy = hopY;

        const speedSq = vx * vx + vy * vy;
        if (speedSq > maxHopSpeedSq) {
            const scale = maxHopSpeed / Math.sqrt(speedSq);
            vx *= scale;
            vy *= scale;
        }
        Body.setVelocity(p, { x: vx, y: vy });
        sumVx += vx;
        sumVy += vy;
    }

    const n = particles.length;
    const avgVx = sumVx / n;
    const avgVy = sumVy / n;
    // リキャッチ時に飛び越えた先（進行方向前方）へ優先着地させるためホップ進行方向を記録
    jellyComposite.hopDirectionX = Math.abs(avgVx) > 0.05 ? (avgVx > 0 ? 1 : -1) : (Math.abs(hopX) > 0.05 ? (hopX > 0 ? 1 : -1) : 0);

    if (!jellyComposite.centroidVel) {
        jellyComposite.centroidVel = { x: avgVx, y: avgVy };
    } else {
        jellyComposite.centroidVel.x = avgVx;
        jellyComposite.centroidVel.y = avgVy;
    }
}

// ==========================================
// updateSoftBodies() 用 責務別サブ関数群
// ==========================================

/**
 * サブ関数1：合体時の Ease-Out-Back 膨張成長（Grow-In）および円形⇔横長カプセルモーフィングを更新する
 */
function updateGrowAndMorphConstraints(comp, now) {
    let needsConstraintSync = false;

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
        needsConstraintSync = true;
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
        needsConstraintSync = true;
    }

    if (!needsConstraintSync) return;

    const curScale = comp.currentGrowScale || 1.0;
    const blend = (comp.shapeBlend !== undefined) ? comp.shapeBlend : (comp.isFloating ? 1 : 0);

    const circleArea = comp.fullTargetArea || (Math.PI * (comp.fullRingRadius || 16) ** 2);
    const capsuleArea = comp.capsuleTargetArea || circleArea;
    const blendedArea = circleArea + (capsuleArea - circleArea) * blend;
    comp.targetArea = blendedArea * curScale * curScale;
    comp.ringRadius = (comp.fullRingRadius || comp.ringRadius) * curScale;

    const skinCs = comp.skinConstraints;
    const capSegs = comp.capsuleSegmentLengths;
    const circSeg = comp.fullSegmentLength || 10;
    if (skinCs) {
        for (let j = 0; j < skinCs.length; j++) {
            const capLen = capSegs ? capSegs[j] : circSeg;
            skinCs[j].length = (circSeg + (capLen - circSeg) * blend) * curScale;
        }
    }

    const bendCs = comp.bendConstraints;
    const capBends = comp.capsuleBendLengths;
    const circBend = comp.fullBendLength || 18;
    if (bendCs) {
        for (let j = 0; j < bendCs.length; j++) {
            const capLen = capBends ? capBends[j] : circBend;
            bendCs[j].length = (circBend + (capLen - circBend) * blend) * curScale;
        }
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

    return { cx, cy, vx, vy, signedArea, perimeter };
}

/**
 * サブ関数2.5：斜め下ショット限定すり抜け保護（barGraceActive）の AABB 完全離脱検知解除
 * 全 BAR_FLOATING ゼリーとの重なりが完全に消えた瞬間、または上限 220ms 経過で通常衝突マスクへ安全復帰する
 */
function updateBarGraceState(comp, composites, now) {
    if (!comp.barGraceActive) return;

    const maxGraceMs = FLOAT_BAR.LAUNCH_BAR_GRACE_MAX_MS || 220;
    const elapsed = now - (comp.barGraceStartTime || now);

    let overlapsAnyFloating = false;
    if (elapsed < maxGraceMs && comp.aabb) {
        const aA = comp.aabb;
        const rA = comp.particleRadius || 4;
        for (let i = 0; i < composites.length; i++) {
            const other = composites[i];
            if (!other || other === comp || other.label !== 'jelly_composite' || !other.isFloating || !other.aabb) {
                continue;
            }
            const aB = other.aabb;
            const pad = rA + (other.particleRadius || 4) + 2;
            if (!(aA.maxX + pad < aB.minX || aA.minX - pad > aB.maxX ||
                  aA.maxY + pad < aB.minY || aA.minY - pad > aB.maxY)) {
                overlapsAnyFloating = true;
                break;
            }
        }
    }

    if (!overlapsAnyFloating || elapsed >= maxGraceMs) {
        comp.barGraceActive = false;
        comp.barGraceStartTime = 0;
        if (!comp.isFloating && !comp.isBarHopping) {
            setSoftBodyCollisionCategory(comp, COLLISION_CATEGORY.FIELD_JELLY, MASK_FIELD_JELLY);
        }
    }
}

/**
 * サブ関数3：穏健なアンチ裏返り自動修復 OR 完全液体物理（強化非線形バルク内圧＋体積粘性＋最小距離復元）
 * ※PBD位置ワープおよび真円形状保持（SHAPE_MATCH）は完全撤廃
 */
function applyVolumeAndShapeForces(comp, geom) {
    const particles = comp.particles;
    const n = particles.length;
    const pRadius = comp.particleRadius || 4;
    const ringRadius = comp.ringRadius || 16;
    const targetArea = comp.targetArea || (Math.PI * ringRadius * ringRadius);
    const { cx, cy, vx: centVx, vy: centVy, signedArea } = geom;

    const inversionRatio = (PHYSICS.INVERSION_AREA_RATIO !== undefined) ? PHYSICS.INVERSION_AREA_RATIO : 0.18;
    const pressureCoeff = PHYSICS.SOFTBODY_PRESSURE || 0.0024;
    const nlGain = (PHYSICS.PRESSURE_NONLINEAR_GAIN !== undefined) ? PHYSICS.PRESSURE_NONLINEAR_GAIN : 6.5;
    const nlThreshold = (PHYSICS.PRESSURE_NONLINEAR_THRESHOLD !== undefined) ? PHYSICS.PRESSURE_NONLINEAR_THRESHOLD : 0.28;
    const pressureMax = PHYSICS.PRESSURE_RATIO_MAX || 3.8;
    const bulkDamping = (PHYSICS.BULK_DAMPING !== undefined) ? PHYSICS.BULK_DAMPING : 0.00055;
    const minDistRatio = PHYSICS.SOFTBODY_MIN_DIST_RATIO || 0.48;
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

            Body.setPosition(pCurr, { x: clampedPt.x, y: clampedPt.y });
            Body.setVelocity(pCurr, {
                x: pCurr.velocity.x * 0.55,
                y: pCurr.velocity.y * 0.55
            });
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

    // (C) 強化非線形バルク内圧（平常時はトロッと液体、極限圧迫時のみ強い非圧縮反発で13倍荷重に耐える）
    const compression = (targetArea - signedArea) / Math.max(1, targetArea);
    let effectiveRatio = compression;
    if (compression > nlThreshold) {
        const excess = compression - nlThreshold;
        effectiveRatio = compression + excess * excess * nlGain;
    }
    if (effectiveRatio > pressureMax) effectiveRatio = pressureMax;
    else if (effectiveRatio < -0.8) effectiveRatio = -0.8;

    const pressureStrength = effectiveRatio * pressureCoeff * 5.0;

    // 上段横長カプセル・ホップ半カプセル時は縦半高を基準に最小距離を安全算出
    const effectiveMinRadius = (comp.isFloating || comp.isBarHopping)
        ? Math.min(ringRadius, comp.capsuleRingHalfHeight || ringRadius)
        : ringRadius;
    const minDist = effectiveMinRadius * minDistRatio;

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
        if (bulkDamping > 0) {
            const relVx = pCurr.velocity.x - centVx;
            const relVy = pCurr.velocity.y - centVy;
            const vn = relVx * nx + relVy * ny;
            const dampForce = -vn * bulkDamping * pCurr.mass;
            forceX += nx * dampForce;
            forceY += ny * dampForce;
        }

        // 3. 最小距離復元（重心への過度なめり込みを防止）
        if (dist < minDist) {
            const overlap = minDist - dist;
            const restoreMag = overlap * 0.00045 * pCurr.mass;
            forceX += radialX * restoreMag;
            forceY += radialY * restoreMag;
        }

        Body.applyForce(pCurr, pCurr.position, { x: forceX, y: forceY });
    }
}

/**
 * ホップ着地時の「進行方向前方優先 ＆ 壁際閉塞回避付き 異数字限定セーフ・リキャッチ」
 * 進行方向の前方（飛び越えた先）へ優先着地し、重なる異数字カプセルを後ろ側へスッと押し分ける（同数字は即合体）
 */
function applySafeRecatchSeparation(comp, composites, hopDirX = 0) {
    if (!comp || !comp.centroid) return;

    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const padX = Math.max(frameW + 4, FLOAT_BAR.PADDING_X || 26);
    const compHalfW = comp.capsuleHalfWidth || comp.targetRadius || 21.5;
    const minCenterX = padX + compHalfW;
    const maxCenterX = GAME_WIDTH - padX - compHalfW;
    const forwardDir = (hopDirX > 0.05) ? 1 : ((hopDirX < -0.05) ? -1 : 0);

    for (let i = 0; i < composites.length; i++) {
        const other = composites[i];
        if (!other || other === comp || other.label !== 'jelly_composite' || !other.isFloating || other.isMerging) {
            continue;
        }
        // 同数字は押し分けず、そのまま接触させて上段即合体を成立させる
        if (other.jellyValue === comp.jellyValue) {
            continue;
        }
        if (!other.centroid) continue;

        const otherHalfW = other.capsuleHalfWidth || other.targetRadius || 21.5;
        const requiredDist = compHalfW + otherHalfW + 2;
        const dx = other.centroid.x - comp.centroid.x;
        const absDx = Math.abs(dx);

        if (absDx < requiredDist) {
            const otherMinX = padX + otherHalfW;
            const otherMaxX = GAME_WIDTH - padX - otherHalfW;

            // 進行方向前方への乗り越え着地が可能かを優先判定（元の側へ押し戻されるバグを解消）
            let pushDir = dx >= 0 ? 1 : -1;
            let neededSep = requiredDist - absDx;

            if (forwardDir !== 0) {
                // 相手中心に対する前方方向への符号付き距離（正＝すでに飛び越え済み、負＝中心の手前）
                const signedForward = (comp.centroid.x - other.centroid.x) * forwardDir;
                if (signedForward >= -requiredDist * 0.25) {
                    const forwardSep = requiredDist - signedForward;
                    const backDir = -forwardDir;
                    const otherBackRoom = backDir > 0
                        ? Math.max(0, otherMaxX - other.centroid.x)
                        : Math.max(0, other.centroid.x - otherMinX);
                    const selfForwardRoom = forwardDir > 0
                        ? Math.max(0, maxCenterX - comp.centroid.x)
                        : Math.max(0, comp.centroid.x - minCenterX);

                    if (otherBackRoom + selfForwardRoom >= forwardSep - 1) {
                        pushDir = backDir;
                        neededSep = forwardSep;
                    }
                }
            } else if (absDx < 0.5) {
                pushDir = (other.centroid.x >= GAME_WIDTH * 0.5) ? 1 : -1;
            }

            // 相手を pushDir 側へ動かせる余裕量を計測し、足りない分は着地ゼリー側を逆方向（-pushDir）へ安全シフト
            const otherRoom = pushDir > 0
                ? Math.max(0, otherMaxX - other.centroid.x)
                : Math.max(0, other.centroid.x - otherMinX);

            const idealOtherShift = neededSep * 0.65;
            const actualOtherShift = Math.min(idealOtherShift, otherRoom);
            const remainOverlap = neededSep - actualOtherShift;

            if (actualOtherShift > 0.1) {
                shiftSoftBody(other, pushDir * actualOtherShift, 0);
                // 滑らかに割り込めるよう軽い横滑り速度も付与
                const oPts = other.particles;
                for (let k = 0; k < oPts.length; k++) {
                    Body.setVelocity(oPts[k], {
                        x: oPts[k].velocity.x + pushDir * 0.35,
                        y: oPts[k].velocity.y
                    });
                }
            }

            if (remainOverlap > 0.1) {
                const selfDir = -pushDir;
                const selfRoom = selfDir > 0
                    ? Math.max(0, maxCenterX - comp.centroid.x)
                    : Math.max(0, comp.centroid.x - minCenterX);
                const actualSelfShift = Math.min(remainOverlap, selfRoom);
                if (actualSelfShift > 0.1) {
                    shiftSoftBody(comp, selfDir * actualSelfShift, 0);
                }
            }
        }
    }
}

/**
 * ホップ着地時に下段フィールド内ゼリーが高く積み上がっている場合、重なり爆発を防ぐため安全高度へ着地位置を補正する
 */
function ensureSafeHopLandingAltitude(comp, composites) {
    if (!comp || !comp.centroid || !comp.aabb) return;

    const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;
    const compHalfH = comp.capsuleHalfHeight || comp.targetRadius || 21.5;
    const minSafeCenterY = topBarH + compHalfH + 2;
    const rA = comp.particleRadius || 4;
    const aA = comp.aabb;

    let minFieldTopY = Infinity;
    for (let i = 0; i < composites.length; i++) {
        const other = composites[i];
        if (!other || other === comp || other.label !== 'jelly_composite' ||
            other.isFloating || other.isBarHopping || !other.aabb) {
            continue;
        }
        const aB = other.aabb;
        const rB = other.particleRadius || 4;
        // 水平方向が重なっている下段ゼリーの最上端を計測
        if (!(aA.maxX + rA < aB.minX - rB || aA.minX - rA > aB.maxX + rB)) {
            const topY = aB.minY - rB;
            if (topY < minFieldTopY) {
                minFieldTopY = topY;
            }
        }
    }

    if (isFinite(minFieldTopY)) {
        const desiredSafeY = Math.max(minSafeCenterY, Math.min(FLOAT_BAR.Y, minFieldTopY - compHalfH - 2));
        if (comp.centroid.y > desiredSafeY + 1) {
            shiftSoftBody(comp, 0, desiredSafeY - comp.centroid.y);
        }
    }
}

/**
 * サブ関数4：天井非激突 2.5D 上段飛び越えホップの専用重力・半カプセル水平安定 ＆ セーフ・リキャッチ制御
 */
function updateBarHopState(comp, geom, composites, now, gravityY, gravityScale) {
    if (!comp.isBarHopping) return;

    const particles = comp.particles;
    const n = particles.length;
    const { cx, cy, vx: avgVx, vy: avgVy } = geom;
    const hopGravityScale = (FLOAT_BAR.HOP_GRAVITY_SCALE !== undefined) ? FLOAT_BAR.HOP_GRAVITY_SCALE : 1.35;
    const hopMinAirMs = FLOAT_BAR.HOP_MIN_AIR_MS || 160;
    const hopRecatchYMin = FLOAT_BAR.HOP_RECATCH_Y_MIN || 92;
    const hopRecatchYMax = FLOAT_BAR.HOP_RECATCH_Y_MAX || 138;
    const hopMaxAirMs = FLOAT_BAR.HOP_MAX_AIR_MS || 2200;

    // 壁反射などで飛行中の進行方向が変わった場合も最新方向へ同期
    if (Math.abs(avgVx) > 0.08) {
        comp.hopDirectionX = avgVx > 0 ? 1 : -1;
    }

    const airMs = now - (comp.hopStartTime || now);
    // 下降フェーズでバー高度帯へ到達、または下抜け防止・タイムアウトで上段バーへ自動再吸着
    const isDescendingIntoBar = (airMs >= hopMinAirMs) && (
        (avgVy >= 0 && cy >= hopRecatchYMin && cy <= hopRecatchYMax) ||
        (cy > hopRecatchYMax)
    );
    const isTimedOut = airMs >= hopMaxAirMs;

    if (isDescendingIntoBar || isTimedOut) {
        const landingHopDirX = comp.hopDirectionX || (Math.abs(avgVx) > 0.05 ? (avgVx > 0 ? 1 : -1) : 0);

        comp.isBarHopping = false;
        comp.isFloating = true;
        comp.hopStartTime = 0;
        comp.hopDirectionX = 0;

        // 下段高積み上げ時の重なり暴発を防ぐ安全着地高度チェックを適用
        ensureSafeHopLandingAltitude(comp, composites);

        // 上段待機カテゴリへ復帰（着地先の同数字と即座に合体・異数字と押し合い可能）
        setSoftBodyCollisionCategory(comp, COLLISION_CATEGORY.BAR_FLOATING);
        // 140msかけて半カプセルから横長カプセルへ滑らかに着席モーフィング
        startShapeMorph(comp, 1.0, FLOAT_BAR.RECATCH_MORPH_DURATION_MS || 140, now);

        // 着地時の縦勢いを吸収し、横の勢いを適度に残して隣ゼリーとの合体・着地を滑らかにする
        for (let j = 0; j < n; j++) {
            const body = particles[j];
            Body.setVelocity(body, {
                x: body.velocity.x * 0.65,
                y: body.velocity.y * 0.15
            });
        }

        // 進行方向前方優先・壁際閉塞回避付きの異数字限定セーフ・リキャッチ（同数字は即合体させるため押し分けない）
        applySafeRecatchSeparation(comp, composites, landingHopDirX);
        return;
    }

    // ホップ滞空中：専用重力倍率（HOP_GRAVITY_SCALE）＋ 半カプセル水平姿勢安定（空中で縦回転して天井に当たるのを防止）
    const cancelRatio = 1 - hopGravityScale;
    const capPts = comp.capsuleLocalPoints;
    const circPts = comp.circleLocalPoints;
    const blend = (comp.shapeBlend !== undefined) ? comp.shapeBlend : 0.5;
    const curScale = comp.currentGrowScale || 1.0;

    for (let j = 0; j < n; j++) {
        const body = particles[j];
        let forceX = 0;
        let forceY = -gravityY * gravityScale * cancelRatio * body.mass;

        // 飛行中の半カプセル水平姿勢を穏やかに安定化
        if (capPts && circPts && capPts[j] && circPts[j]) {
            const idealLocalX = (circPts[j].x + (capPts[j].x - circPts[j].x) * blend) * curScale;
            const idealLocalY = (circPts[j].y + (capPts[j].y - circPts[j].y) * blend) * curScale;
            forceX += (cx + idealLocalX - body.position.x) * 0.00014 * body.mass;
            forceY += (cy + idealLocalY - body.position.y) * 0.00024 * body.mass;
        }

        Body.applyForce(body, body.position, { x: forceX, y: forceY });
    }
}

/**
 * サブ関数5：上段フロートバー上の無重力フック・柔らかな上下レール圧縮・極弱姿勢ガイド・低減衰横スライド制御
 */
function applyFloatBarControl(comp, cx, cy, gravityY, gravityScale, stepDampX, stepDampY) {
    if (!comp.isFloating) return;

    const particles = comp.particles;
    const n = particles.length;
    const targetY = FLOAT_BAR.Y;
    const centerX = GAME_WIDTH / 2;
    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const safePadX = Math.max(frameW + 4, FLOAT_BAR.PADDING_X || 26);
    const halfWidth = comp.capsuleHalfWidth || comp.targetRadius || 21.5;
    const barMinX = safePadX + halfWidth;
    const barMaxX = GAME_WIDTH - safePadX - halfWidth;
    const packForce = FLOAT_BAR.PACK_FORCE || 0.00005;
    const curScale = comp.currentGrowScale || 1.0;

    // 上下フラット帯（CHANNEL_HALF_HEIGHT）への圧縮フック設定
    const capRingHalfH = (comp.capsuleRingHalfHeight || Math.max(4, (FLOAT_BAR.CHANNEL_HALF_HEIGHT || 22) - (comp.particleRadius || 4))) * curScale;
    const channelTopY = targetY - capRingHalfH;
    const channelBottomY = targetY + capRingHalfH;
    const compStiff = (FLOAT_BAR.CHANNEL_COMPRESSION_STIFFNESS !== undefined) ? FLOAT_BAR.CHANNEL_COMPRESSION_STIFFNESS : 0.055;
    const capPts = comp.capsuleLocalPoints;

    // 中央方向への微弱な寄せ力（左右端スポーナーからスルスル合流させる）
    const dxCenter = centerX - cx;
    const packRatio = Math.max(-1, Math.min(1, dxCenter / 40));

    let boundaryForceX = packRatio * packForce;
    if (barMinX <= barMaxX) {
        if (cx < barMinX) {
            boundaryForceX += (barMinX - cx) * FLOAT_BAR.SPRING_STIFFNESS * 0.0006;
        } else if (cx > barMaxX) {
            boundaryForceX += (barMaxX - cx) * FLOAT_BAR.SPRING_STIFFNESS * 0.0006;
        }
    } else {
        boundaryForceX += (centerX - cx) * FLOAT_BAR.SPRING_STIFFNESS * 0.0006;
    }

    const dyBar = targetY - cy;
    const baseHoldY = dyBar * FLOAT_BAR.SPRING_STIFFNESS * 0.00045;

    for (let j = 0; j < n; j++) {
        const body = particles[j];

        // 1. 重力打ち消し（無重力化）＋ バー高度への弾性フック
        const antiGravityY = -gravityY * gravityScale * body.mass;
        let forceX = boundaryForceX * body.mass;
        let forceY = antiGravityY + baseHoldY * body.mass;

        // 2. 上下フラットレール圧縮フック（定規のような直線を避け、丸みとたわみのある柔らかい帯に収める）
        if (body.position.y < channelTopY) {
            forceY += (channelTopY - body.position.y) * compStiff * 0.0018 * body.mass;
        } else if (body.position.y > channelBottomY) {
            forceY += (channelBottomY - body.position.y) * compStiff * 0.0018 * body.mass;
        }

        // 3. 横長カプセル水平姿勢の極弱ガイド（X方向強制を撤廃し、液体らしい丸みとたわみを許容）
        if (capPts && capPts[j]) {
            const idealY = targetY + capPts[j].y * curScale;
            forceY += (idealY - body.position.y) * 0.00006 * body.mass;
        }

        Body.applyForce(body, body.position, { x: forceX, y: forceY });

        // 横方向は極低ダンピング（スルスル滑る）、縦方向は液体らしいタプタプ揺れを残す減衰を適用
        Body.setVelocity(body, {
            x: body.velocity.x * stepDampX,
            y: body.velocity.y * stepDampY
        });
    }
}

/**
 * サブ関数5.5：遅延ランプアップ型「適応的圧迫ダンピング」（面積歪み復元保護付き）
 * 着地直後 350ms の液体ボヨヨン揺れおよび面積歪み復元途中は無傷で保護し、
 * 下段で形状が復元しきって全体が静止（< 0.22 px/frame）し続けた場合のみ
 * 350ms → 900ms へ滑らかに重心相対速度（内部微振動）を減衰させて下敷き小塊をピタッと静寂化する
 */
function applyAdaptiveSettleDamping(comp, geom, subDeltaMs, substeps) {
    if (comp.isFloating || comp.isBarHopping || comp.isGrowing) {
        comp.lowSpeedMs = 0;
        return;
    }

    // 面積歪みが大きい復元途中は減衰させず奇形凍結を防止
    const targetArea = comp.targetArea || (Math.PI * (comp.ringRadius || 16) * (comp.ringRadius || 16));
    const areaRatio = geom.signedArea / Math.max(1, targetArea);
    if (Math.abs(1 - areaRatio) > 0.12) {
        comp.lowSpeedMs = 0;
        return;
    }

    const speedThresh = PHYSICS.SETTLE_SPEED_THRESHOLD || 0.22;
    const centVx = geom.vx;
    const centVy = geom.vy;
    const centSpeedSq = centVx * centVx + centVy * centVy;

    if (centSpeedSq >= speedThresh * speedThresh) {
        comp.lowSpeedMs = 0;
        return;
    }

    comp.lowSpeedMs = (comp.lowSpeedMs || 0) + subDeltaMs;

    const delayMs = (PHYSICS.SETTLE_DELAY_MS !== undefined) ? PHYSICS.SETTLE_DELAY_MS : 350;
    if (comp.lowSpeedMs < delayMs) return;

    const rampMs = Math.max(1, PHYSICS.SETTLE_RAMP_MS || 550);
    const rampT = Math.min(1, (comp.lowSpeedMs - delayMs) / rampMs);
    const maxFrameDamp = PHYSICS.SETTLE_MAX_DAMPING || 0.88;
    const frameDamp = 1 - (1 - maxFrameDamp) * rampT;
    const stepRelDamp = Math.pow(frameDamp, 1 / substeps);

    const particles = comp.particles;
    const n = particles.length;
    for (let j = 0; j < n; j++) {
        const body = particles[j];
        const relVx = body.velocity.x - centVx;
        const relVy = body.velocity.y - centVy;
        Body.setVelocity(body, {
            x: centVx + relVx * stepRelDamp,
            y: centVy + relVy * stepRelDamp
        });
    }
}

/**
 * サブ関数6：すり抜け・物理爆発防止 ＆ 横失速根絶のX/Y独立最大速度クランプ（SUBSTEPS=4 正規化済み）
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
            Body.setVelocity(body, {
                x: clampedVx,
                y: clampedVy
            });
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
    const maxVy = PHYSICS.MAX_PARTICLE_VY || 11.0;

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

        // 1. 合体成長（Ease-Out-Back Grow-In）＆ カプセル⇔半カプセル⇔円形モーフィングの更新
        updateGrowAndMorphConstraints(comp, now);

        // 2. 重心・重心速度・符号付き面積・周長・AABBの算出
        const geom = computeBodyGeometry(comp);

        // 2.5 斜め下ショットすり抜け保護（AABB完全離脱検知による即解除）
        updateBarGraceState(comp, composites, now);

        // 3. 穏健なアンチ裏返り修復 / 強化非線形バルク内圧・体積粘性の適用
        applyVolumeAndShapeForces(comp, geom);

        // 4. 天井非激突 2.5D上段飛び越えホップ（半カプセル水平安定 ＆ 進行方向優先セーフ・リキャッチ）
        updateBarHopState(comp, geom, composites, now, gravityY, gravityScale);

        // 5. 上段フロートバー上の無重力フック・柔らかな上下レール圧縮・低減衰スライド
        applyFloatBarControl(comp, geom.cx, geom.cy, gravityY, gravityScale, stepDampX, stepDampY);

        // 5.5 遅延ランプアップ型「適応的圧迫ダンピング」（面積歪み復元保護付き静寂化）
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