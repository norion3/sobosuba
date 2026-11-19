/**
 * softbody.js
 * @version v5.0 (Final Overhaul & Refactoring Step 4)
 * @changes
 *   - リファクタリング整理として、非侵入排斥ソルバーおよびポリゴン包含判定を overlap_solver.js へ委譲し、updateSoftBodies() を責務別の6サブ関数へ分割整理
 *   - 上段フロートバー待機用の「横長カプセル（ピル）形状」生成・上下フラットレール圧縮フック・発射時の円形モーフィング（160ms）およびホップ着地時のカプセル復帰モーフィング（140ms）を実装
 *   - 下段フィールド落下後の造形美化のため、弱めの形状保持（PHYSICS.SHAPE_MATCH_STIFFNESS）・強化された内圧＆1つ飛ばし曲げ剛性・Ease-Out-Back オーバーシュート（1.08倍）付き Grow-In 成長を実装
 *   - 2.5D飛び越えレーン方式ホップのため COLLISION_CATEGORY（FIELD_JELLY / BAR_FLOATING / BAR_HOPPING）の動的切替を実装し、ホップ飛行中は他の待機・下段ゼリーと衝突せず確実に飛び越えて自動再吸着する挙動へ刷新
 *   - floatbar.js / aim.js 連携用の横長実幅取得ヘルパー getSoftBodyHalfExtents() および getCapsuleHalfExtentsForValue() を追加し、絶対パスを ?v=5 へ統一
 * 
 * ソフトボディ（中空ビーズリング剛体）の生成・物理更新モジュール
 * 
 * 中心に剛体コアを持たず、外周の隙間ゼロ数珠つなぎビーズと表面張力・曲げ拘束・
 * 力ベース内部圧力・弱形状保持・分散非侵入排斥により、上段では横長カプセルとして並び、
 * 下段では美しい角丸多角形として密着する本家sobosuba風の挙動と2.5D上段飛び越えホップを実現します。
 * ESM経由でMatter.jsを直接読み込み、起動エラーを防ぎます。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, PHYSICS, JELLY_CONFIG, FLOAT_BAR, EFFECTS, COLLISION_CATEGORY } from '/sobosuba/constants.js?v=5';
import { clampPointToContainer } from '/sobosuba/physics.js?v=5';
import { solveAntiOverlap } from '/sobosuba/overlap_solver.js?v=5';

const Bodies = Matter.Bodies;
const Composite = Matter.Composite;
const Constraint = Matter.Constraint;
const Body = Matter.Body;

// ゼリーを一意に識別するためのカウンター（合体判定などで使用）
let jellyIdCounter = 0;

// ==========================================
// 衝突マスク定義（2.5D飛び越えレーン ＆ バンパー誤爆ゼロ）
// ==========================================
const MASK_FIELD_JELLY =
    COLLISION_CATEGORY.WALL |
    COLLISION_CATEGORY.BUMPER |
    COLLISION_CATEGORY.FIELD_JELLY |
    COLLISION_CATEGORY.BAR_FLOATING;

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
 * 状態カテゴリに応じた衝突マスクを返す
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
 */
function setSoftBodyCollisionCategory(comp, category) {
    if (!comp || !comp.particles) return;
    const mask = getCollisionMaskForCategory(category);
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
    const radius = config ? config.radius : 21;
    const channelHalfH = FLOAT_BAR.CHANNEL_HALF_HEIGHT || 21;
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
 * @param {number} targetBlend - 目標ブレンド値（0.0=円形, 1.0=横長カプセル）
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
    const particleCount = Math.max(14, config.particles || 14);

    // 隙間ゼロ高密度シームレス・ビーズリング半径の算出
    // 隣接ビーズ直径 >= BEAD_MIN_OVERLAP_RATIO * 弦長 を数学的に保証する
    const beadRatio = PHYSICS.BEAD_RADIUS_RATIO || 0.25;
    const minOverlap = PHYSICS.BEAD_MIN_OVERLAP_RATIO || 1.35;
    const sinHalf = Math.sin(Math.PI / particleCount);
    const minSeamlessBeadRadius = (minOverlap * sinHalf / (1 + minOverlap * sinHalf)) * radius;
    const particleRadius = Math.max(3.5, radius * beadRatio, minSeamlessBeadRadius);
    const fullRingRadius = Math.max(4, radius - particleRadius);

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
    const circleSegmentLength = 2 * fullRingRadius * Math.sin(Math.PI / particleCount);
    const circleBendLength = 2 * fullRingRadius * Math.sin((2 * Math.PI) / particleCount);
    const circleTargetArea = 0.5 * particleCount * fullRingRadius * fullRingRadius * Math.sin((2 * Math.PI) / particleCount);

    const capsuleSegmentLengths = new Array(particleCount);
    const capsuleBendLengths = new Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
        const pCurr = capsuleLocalPoints[i];
        const pNext1 = capsuleLocalPoints[(i + 1) % particleCount];
        const pNext2 = capsuleLocalPoints[(i + 2) % particleCount];
        capsuleSegmentLengths[i] = Math.hypot(pNext1.x - pCurr.x, pNext1.y - pCurr.y);
        capsuleBendLengths[i] = Math.hypot(pNext2.x - pCurr.x, pNext2.y - pCurr.y);
    }
    const capsuleTargetArea = Math.max(16, computePolygonArea(capsuleLocalPoints));

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
    // 1. 外周ビーズ剛体（隙間ゼロ中空リング：中心コアなし）の生成
    // ==========================================
    const particles = [];
    const spawnPts = isFloating ? capsuleLocalPoints : circleLocalPoints;

    for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2;
        const rawPx = x + spawnPts[i].x * clampedStartScale;
        const rawPy = y + spawnPts[i].y * clampedStartScale;
        const clamped = clampPointToContainer(rawPx, rawPy, particleRadius, tempClampPoint);

        const particle = Bodies.circle(clamped.x, clamped.y, particleRadius, {
            density: PHYSICS.DENSITY_PARTICLE,
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
    // 2. 隣接ビーズ間の皮の張りバネ（表面張力）の生成
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
    // 3. 1つ飛ばしビーズ間の曲げ拘束（シワ折れ・フック奇形防止）
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

    // コンポジット自体に高速参照用・物理更新用のメタデータを保持
    jellyComposite.jellyId = currentJellyId;
    jellyComposite.jellyValue = value;
    jellyComposite.isMerging = false;
    jellyComposite.mergePartnerId = null;
    jellyComposite.isFloating = Boolean(isFloating);
    jellyComposite.isBarHopping = false;
    jellyComposite.hopStartTime = 0;
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

    // 幾何状態キャッシュ
    jellyComposite.centroid = { x, y };
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
 * 対象ゼリーの現在の実効半幅・半高（横長カプセル対応）を取得する
 * floatbar.js のクリアランス検知および aim.js の横長タップ判定で使用
 * @param {Matter.Composite} jellyComposite - 対象のゼリーコンポジット
 * @returns {{ halfWidth: number, halfHeight: number }}
 */
export function getSoftBodyHalfExtents(jellyComposite) {
    if (!jellyComposite) {
        return { halfWidth: 21, halfHeight: 21 };
    }

    const r = jellyComposite.targetRadius || 21;
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
 * 発射瞬間に上下圧縮を解除し、160msかけて横長カプセルから円形スライムへモーフィングする
 * @param {Matter.Composite} jellyComposite - 発射するゼリーのコンポジット
 * @param {Object} addVelocity - 加算する発射速度ベクトル {x, y}（そっと落とし時は {x: 0, y: 0}）
 */
export function launchFloatingJelly(jellyComposite, addVelocity = { x: 0, y: 0 }) {
    if (!jellyComposite) return;
    jellyComposite.isFloating = false;
    jellyComposite.isBarHopping = false;
    jellyComposite.hopStartTime = 0;

    // 下段フィールド用衝突カテゴリへ切替 ＆ 円形スライムへのモーフィング開始（変身の間）
    setSoftBodyCollisionCategory(jellyComposite, COLLISION_CATEGORY.FIELD_JELLY);
    startShapeMorph(jellyComposite, 0.0, FLOAT_BAR.MORPH_DURATION_MS || 160, Date.now());

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
 * 上段フロートバーのゼリーを「2.5D飛び越えレーン方式」の上段ホップ（Bar-Hop）状態で発射する
 * BAR_HOPPING カテゴリへ切り替えて他の待機ゼリーと衝突せず確実に飛び越え、下降時に上段へ自動再吸着する
 * @param {Matter.Composite} jellyComposite - ホップさせるゼリーのコンポジット
 * @param {Object} hopVelocity - ホップ初速ベクトル {x, y}（px/substep 単位）
 */
export function launchBarHop(jellyComposite, hopVelocity = { x: 0, y: -2.0 }) {
    if (!jellyComposite) return;
    const now = Date.now();
    jellyComposite.isFloating = false;
    jellyComposite.isBarHopping = true;
    jellyComposite.hopStartTime = now;

    // 2.5D飛び越えレーン用衝突カテゴリ（壁・天井のみ反射）へ切替 ＆ 空中では丸みへモーフィング
    setSoftBodyCollisionCategory(jellyComposite, COLLISION_CATEGORY.BAR_HOPPING);
    startShapeMorph(jellyComposite, 0.0, FLOAT_BAR.MORPH_DURATION_MS || 160, now);

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

// ==========================================
// updateSoftBodies() 用 責務別サブ関数群（リファクタリング整理）
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

        // 0→startScale、t≒0.7付近でovershoot(1.08)へボヨンと弾み、t=1で1.0へ収束するカーブ
        const easeOut = 1 - Math.pow(1 - rawT, 3);
        const baseScale = startScale + (1 - startScale) * easeOut;
        const bounce = (overshoot - 1) * Math.sin(rawT * Math.PI) * rawT * 1.45;
        comp.currentGrowScale = (rawT >= 1) ? 1.0 : (baseScale + bounce);

        if (rawT >= 1) {
            comp.isGrowing = false;
        }
        needsConstraintSync = true;
    }

    // (B) 横長カプセル ⇔ 円形リングの滑らかなモーフィング補間
    if (comp.isMorphing) {
        const elapsed = Math.max(0, now - (comp.morphStartTime || now));
        const duration = Math.max(1, comp.morphDurationMs || 160);
        const rawT = Math.min(1, elapsed / duration);
        // 滑らかな Ease-Out-Cubic 補間
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
 * サブ関数2：重心・符号付き面積（靴紐の公式）・周長・AABBをインプレース算出する
 * @returns {{ cx: number, cy: number, signedArea: number, perimeter: number }}
 */
function computeBodyGeometry(comp) {
    const particles = comp.particles;
    const n = particles.length;

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

    return { cx, cy, signedArea, perimeter };
}

/**
 * サブ関数3：アンチ裏返り自動修復 OR 力ベース内圧強化＋極小PBD面積補正＋下段弱形状保持＋最小距離復元
 */
function applyVolumeAndShapeForces(comp, geom, substeps) {
    const particles = comp.particles;
    const n = particles.length;
    const pRadius = comp.particleRadius || 4;
    const ringRadius = comp.ringRadius || 16;
    const targetArea = comp.targetArea || (Math.PI * ringRadius * ringRadius);
    const { cx, cy, signedArea, perimeter } = geom;

    const inversionRatio = PHYSICS.INVERSION_AREA_RATIO || 0.28;
    const pbdStiffnessPerStep = (PHYSICS.PBD_AREA_STIFFNESS || 0.28) / substeps;
    const maxCorr = PHYSICS.PBD_MAX_CORRECTION || 0.6;
    const pressureCoeff = PHYSICS.SOFTBODY_PRESSURE || 0.00125;
    const minDistRatio = PHYSICS.SOFTBODY_MIN_DIST_RATIO || 0.48;
    const shapeMatchStiffness = PHYSICS.SHAPE_MATCH_STIFFNESS || 0.00022;
    const curScale = comp.currentGrowScale || 1.0;

    // (A) アンチ裏返り自動修復（ペシャンコ・8の字崩壊の即時復元）
    if (signedArea < targetArea * inversionRatio) {
        const useCapsule = comp.isFloating && comp.capsuleLocalPoints;
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

    // (B) 正常形状時の平均回転角（循環平均）を算出（上段カプセル待機時は水平0へ穏やかに整列）
    if (comp.isFloating) {
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

    // (C) 補助的な極小PBD面積保存補正（他ゼリーや45度スロープへめり込ませない上限 0.6px/step）
    const areaDiff = targetArea - signedArea;
    const safePerimeter = Math.max(perimeter, 1);
    let pbdDelta = (areaDiff / safePerimeter) * pbdStiffnessPerStep;
    if (pbdDelta > maxCorr) pbdDelta = maxCorr;
    else if (pbdDelta < -maxCorr * 0.35) pbdDelta = -maxCorr * 0.35;

    // (D) 主軸となる力ベース内部圧力（ふっくら角丸多角形密着を生む）
    const areaRatio = Math.max(-0.8, Math.min(2.2, areaDiff / targetArea));
    const pressureStrength = areaRatio * pressureCoeff * 5.0;

    // 上段横長カプセル時は縦半高を基準に最小距離を安全算出（縦に無理に膨らませない）
    const effectiveMinRadius = comp.isFloating
        ? Math.min(ringRadius, comp.capsuleRingHalfHeight || ringRadius)
        : ringRadius;
    const minDist = effectiveMinRadius * minDistRatio;

    // (E) 下段フィールド内専用の弱め形状保持（Shape Matching：丸く固めずフック奇形だけ防止）
    const applyFieldShapeMatch = !comp.isFloating && !comp.isBarHopping && shapeMatchStiffness > 0;
    const cosAvg = applyFieldShapeMatch ? Math.cos(comp.avgAngle || 0) : 1;
    const sinAvg = applyFieldShapeMatch ? Math.sin(comp.avgAngle || 0) : 0;
    const circlePts = comp.circleLocalPoints;

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

        // 隣接ビーズ間の接線ベクトルから外向き法線を求める
        const tx = pNext.x - pPrev.x;
        const ty = pNext.y - pPrev.y;
        const tLen = Math.sqrt(tx * tx + ty * ty);

        let nx = radialX;
        let ny = radialY;
        if (tLen > 0.0001) {
            const candNx = ty / tLen;
            const candNy = -tx / tLen;
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
        let forceX = nx * pressureStrength * pCurr.mass;
        let forceY = ny * pressureStrength * pCurr.mass;

        // 最小距離復元（重心への過度なめり込みを防止）
        if (dist < minDist) {
            const overlap = minDist - dist;
            const restoreMag = overlap * 0.00045 * pCurr.mass;
            forceX += radialX * restoreMag;
            forceY += radialY * restoreMag;
        }

        // 下段専用：弱め形状保持（Shape Matching）
        if (applyFieldShapeMatch && circlePts && circlePts[j]) {
            const lx = circlePts[j].x * curScale;
            const ly = circlePts[j].y * curScale;
            const idealX = cx + (lx * cosAvg - ly * sinAvg);
            const idealY = cy + (lx * sinAvg + ly * cosAvg);
            forceX += (idealX - pCurr.position.x) * shapeMatchStiffness * pCurr.mass;
            forceY += (idealY - pCurr.position.y) * shapeMatchStiffness * pCurr.mass;
        }

        Body.applyForce(pCurr, pCurr.position, { x: forceX, y: forceY });
    }
}

/**
 * サブ関数4：2.5D上段飛び越えホップの専用重力（頂点滞空）＆ 下降時の自動再吸着（リキャッチ）制御
 */
function updateBarHopState(comp, cy, now, gravityY, gravityScale) {
    if (!comp.isBarHopping) return;

    const particles = comp.particles;
    const n = particles.length;
    const hopGravityScale = (FLOAT_BAR.HOP_GRAVITY_SCALE !== undefined) ? FLOAT_BAR.HOP_GRAVITY_SCALE : 0.62;
    const hopMinAirMs = FLOAT_BAR.HOP_MIN_AIR_MS || 115;
    const hopRecatchYMin = FLOAT_BAR.HOP_RECATCH_Y_MIN || 92;
    const hopRecatchYMax = FLOAT_BAR.HOP_RECATCH_Y_MAX || 138;
    const hopMaxAirMs = FLOAT_BAR.HOP_MAX_AIR_MS || 2200;

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

        // 上段待機カテゴリへ復帰（着地先の同数字と即座に合体・異数字と押し合い可能）
        setSoftBodyCollisionCategory(comp, COLLISION_CATEGORY.BAR_FLOATING);
        // 140msかけて丸形から横長カプセルへ滑らかに着席モーフィング
        startShapeMorph(comp, 1.0, FLOAT_BAR.RECATCH_MORPH_DURATION_MS || 140, now);

        // 着地時の縦勢いを吸収し、横の勢いを適度に残して隣ゼリーとの合体・着地を滑らかにする
        for (let j = 0; j < n; j++) {
            const body = particles[j];
            Body.setVelocity(body, {
                x: body.velocity.x * 0.65,
                y: body.velocity.y * 0.15
            });
        }
        return;
    }

    // ホップ滞空中：専用重力倍率（0.62倍）になるよう差分を上向き相殺し、頂点にふわっとした滞空の間を作る
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

/**
 * サブ関数5：上段フロートバー上の無重力フック・上下フラットレール圧縮・横長カプセル姿勢維持・低減衰横スライド制御
 */
function applyFloatBarControl(comp, cx, cy, gravityY, gravityScale, stepDampX, stepDampY) {
    if (!comp.isFloating) return;

    const particles = comp.particles;
    const n = particles.length;
    const targetY = FLOAT_BAR.Y;
    const centerX = GAME_WIDTH / 2;
    const halfWidth = comp.capsuleHalfWidth || comp.targetRadius || 21;
    const barMinX = FLOAT_BAR.PADDING_X + halfWidth;
    const barMaxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - halfWidth;
    const packForce = FLOAT_BAR.PACK_FORCE || 0.00005;
    const curScale = comp.currentGrowScale || 1.0;

    // 上下フラット帯（CHANNEL_HALF_HEIGHT）への圧縮フック設定
    const capRingHalfH = (comp.capsuleRingHalfHeight || Math.max(4, (FLOAT_BAR.CHANNEL_HALF_HEIGHT || 21) - (comp.particleRadius || 4))) * curScale;
    const channelTopY = targetY - capRingHalfH;
    const channelBottomY = targetY + capRingHalfH;
    const compStiff = FLOAT_BAR.CHANNEL_COMPRESSION_STIFFNESS || 0.16;
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

        // 2. 上下フラットレール圧縮フック（高さ約42pxの帯に美しく収める）
        if (body.position.y < channelTopY) {
            forceY += (channelTopY - body.position.y) * compStiff * 0.0018 * body.mass;
        } else if (body.position.y > channelBottomY) {
            forceY += (channelBottomY - body.position.y) * compStiff * 0.0018 * body.mass;
        }

        // 3. 横長カプセル水平姿勢の穏やかな保持（待機中に縦向きへ回ってしまうのを防止しつつ横の潰れは許容）
        if (capPts && capPts[j]) {
            const idealX = cx + capPts[j].x * curScale;
            const idealY = targetY + capPts[j].y * curScale;
            forceX += (idealX - body.position.x) * 0.00018 * body.mass;
            forceY += (idealY - body.position.y) * 0.00032 * body.mass;
        }

        Body.applyForce(body, body.position, { x: forceX, y: forceY });

        // 横方向は極低ダンピング（スルスル滑る）、縦方向は揺れを抑える減衰を適用
        Body.setVelocity(body, {
            x: body.velocity.x * stepDampX,
            y: body.velocity.y * stepDampY
        });
    }
}

/**
 * サブ関数6：すり抜け・物理爆発防止の最大速度クランプ（SUBSTEPS=4 正規化済み）
 */
function clampParticleVelocities(comp, maxSpeedSq, maxSpeed) {
    const particles = comp.particles;
    const n = particles.length;
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
}

/**
 * 毎サブステップ呼び出されるソフトボディ物理更新関数
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

    // 1フレームあたりの減衰率をサブステップ回数に応じて等価変換
    const stepDampX = Math.pow(FLOAT_BAR.X_DAMPING || 0.986, 1 / substeps);
    const stepDampY = Math.pow(FLOAT_BAR.Y_DAMPING || 0.88, 1 / substeps);

    const now = Date.now();
    activeJelliesBuffer.length = 0;

    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (!comp || comp.label !== 'jelly_composite') continue;

        const particles = comp.particles;
        if (!particles || particles.length < 3) continue;

        // 1. 合体成長（Ease-Out-Back Grow-In）＆ カプセル⇔円形モーフィングの更新
        updateGrowAndMorphConstraints(comp, now);

        // 2. 重心・符号付き面積・周長・AABBの算出
        const geom = computeBodyGeometry(comp);

        // 3. アンチ裏返り修復 / 内圧・極小PBD・下段弱形状保持の適用
        applyVolumeAndShapeForces(comp, geom, substeps);

        // 4. 2.5D上段飛び越えホップ専用重力 ＆ 自動再吸着（リキャッチ）
        updateBarHopState(comp, geom.cy, now, gravityY, gravityScale);

        // 5. 上段フロートバー上の無重力フック・フラット圧縮・低減衰スライド
        applyFloatBarControl(comp, geom.cx, geom.cy, gravityY, gravityScale, stepDampX, stepDampY);

        // 6. 全ビーズの最大速度クランプ
        clampParticleVelocities(comp, maxSpeedSq, maxSpeed);

        // 分散非侵入排斥ソルバー対象としてバッファへ登録
        activeJelliesBuffer.push(comp);
    }

    // 7. ソフトボディ間「非侵入（Anti-Overlap）排斥ソルバー」を overlap_solver.js へ委譲実行
    solveAntiOverlap(activeJelliesBuffer);
    activeJelliesBuffer.length = 0;
}