/**
 * bar_motion.js
 * @version v8.5 (Hop Recatch Sync, Multi-Pass Safe Recatch, Large-Tier Ceiling Guard, Zero-Alloc Buffers & Fallback Sync - Phase 7)
 * @changes
 *   - updateBarHopState() のリキャッチ開始高度フォールバックを FLOAT_BAR.HOP_RECATCH_Y_MIN（102）へ同期し、予測ドット終端との着地位置ズレを解消
 *   - applySafeRecatchSeparation() を事前確保バッファ使用・最大 3 パス（収束時即終了）の連鎖押し分けへ拡張し、バー上 3〜4 個密集時の異数字めり込みを根絶（同数字は即合体維持）
 *   - 値 64 以上の半カプセル半高が大きいゼリーの天井激突を防止するため、getSafeHopMaxUpSpeed() を追加し launchBarHop() で上向き初速を天井非激突上限へ自動制限
 *   - 毎サブステップ／発射・着地処理内の { x, y } リテラルを事前確保バッファ（tempVec / tempForce / tempClampPoint）へ置換し、GC負荷を削減
 *   - フォールバック値を最新定数へ同期（MAX_PARTICLE_VY: 11.0 → 12.0 / HOP_GRAVITY_SCALE: 2.05 → 1.92 / CHANNEL_HALF_HEIGHT: 22 → 25 / 基準半径: 21.5 → 24.0）
 * 
 * 上段フロートバー上の横長カプセル幾何、通常発射／2.5D上段飛び越えホップ発射API、
 * 斜め下ショットすり抜け保護、セーフ・リキャッチ、および上段無重力レール制御を担うモジュール
 * 
 * softbody.js の下段軟体物理コアから上段モーション責務を分離し、
 * 依存深度の増加や実行時オーバーヘッドを一切発生させずに保守性を高めます。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, PHYSICS, JELLY_CONFIG, FLOAT_BAR, CONTAINER, COLLISION_CATEGORY } from '/sobosuba/constants.js?v=7';
import { clampPointToContainer } from '/sobosuba/physics.js?v=7';

const Body = Matter.Body;

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
// ゼロアロケーション（毎サブステップGC負荷削減）用独立作業バッファ
// ==========================================
const tempClampPoint = { x: 0, y: 0 };
const tempVec = { x: 0, y: 0 };
const tempForce = { x: 0, y: 0 };
const recatchFloatingBuffer = [];

/**
 * 状態カテゴリに応じた標準衝突マスクを返す
 * @param {number} category - COLLISION_CATEGORY のビット値
 * @returns {number} 衝突マスク
 */
export function getCollisionMaskForCategory(category) {
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
    const radius = config ? config.radius : 24.0;
    const channelHalfH = FLOAT_BAR.CHANNEL_HALF_HEIGHT || 25;
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
export function computeCapsuleRingPoints(n, hRing, lRing) {
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
        Body.setPosition(p, clamped);
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
 * 対象ゼリーの現在の実効半幅・半高（横長カプセル対応）を取得する
 * floatbar.js のクリアランス検知および aim.js の横長タップ判定で使用
 * @param {Matter.Composite} jellyComposite - 対象のゼリーコンポジット
 * @returns {{ halfWidth: number, halfHeight: number }}
 */
export function getSoftBodyHalfExtents(jellyComposite) {
    if (!jellyComposite) {
        return { halfWidth: 24.0, halfHeight: 24.0 };
    }

    const r = jellyComposite.targetRadius || 24.0;
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
 * 半カプセル半高が大きいゼリー（値 64 以上）のホップ飛行時に、天井へ激突しない上向き初速上限（px/frame 正値）を算出する
 * （値 32 以下は現行上限 FLOAT_BAR.HOP_MAX_UP_SPEED をそのまま維持し、aim.js の予測軌道と 100% 同期する）
 * @param {Matter.Composite|null} jellyComposite - ホップ対象のゼリーコンポジット
 * @returns {number} 天井非激突の上向き初速上限（px/frame）
 */
export function getSafeHopMaxUpSpeed(jellyComposite) {
    const defaultMaxUp = (FLOAT_BAR.HOP_MAX_UP_SPEED !== undefined) ? FLOAT_BAR.HOP_MAX_UP_SPEED : 6.55;
    if (!jellyComposite) return defaultMaxUp;

    const val = jellyComposite.jellyValue || 1;
    if (val < 64) return defaultMaxUp;

    const r = jellyComposite.targetRadius || 24.0;
    const capH = jellyComposite.capsuleHalfHeight || r;
    const halfH = (r + capH) * 0.5;
    const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;
    const startY = FLOAT_BAR.Y;
    const ceilingMargin = 3;
    const maxRise = Math.max(8, startY - (topBarH + halfH + ceilingMargin));

    // Matter.js SUBSTEPS=4 固定刻み積分と一致する1フレームあたりのホップ重力加速度から安全初速上限を算出
    const substeps = Math.max(1, PHYSICS.SUBSTEPS || 4);
    const baseDelta = 1000 / 60;
    const subDelta = baseDelta / substeps;
    const timeScale = subDelta / baseDelta;
    const gravityY = (PHYSICS.GRAVITY_Y !== undefined) ? PHYSICS.GRAVITY_Y : 0.66;
    const hopGravScale = (FLOAT_BAR.HOP_GRAVITY_SCALE !== undefined) ? FLOAT_BAR.HOP_GRAVITY_SCALE : 1.92;
    const subAccVy = (gravityY * 0.001 * hopGravScale * subDelta * subDelta) / timeScale;
    const frameAccY = Math.max(0.001, subAccVy * substeps);

    const safeMaxUp = Math.sqrt(2 * frameAccY * maxRise);
    return Math.min(defaultMaxUp, safeMaxUp);
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

    // 空中超液体モードへ移行（初着地検知まで柔らかい液体挙動を解放）
    jellyComposite.hasLanded = false;
    jellyComposite.landedAt = 0;
    jellyComposite.launchedAt = now;
    jellyComposite.landedFirmness = 0.0;
    jellyComposite._lastAppliedFirmness = -1;

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
    const maxVy = PHYSICS.MAX_PARTICLE_VY || 12.0;

    let sumVx = 0;
    let sumVy = 0;

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        // 本家v1.2準拠：バー上での横移動速度を保持したまま発射ベクトルを加算し、X/Y独立クランプで横失速を根絶
        const vx = Math.max(-maxVx, Math.min(maxVx, p.velocity.x + addX));
        const vy = Math.max(-maxVy, Math.min(maxVy, p.velocity.y + addY));

        tempVec.x = vx;
        tempVec.y = vy;
        Body.setVelocity(p, tempVec);
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

    // 上段ホップ飛行中は上段完全保護状態を維持（空中超液体モードは適用しない）
    jellyComposite.hasLanded = false;
    jellyComposite.landedAt = 0;
    jellyComposite.launchedAt = 0;
    jellyComposite.landedFirmness = 0.0;
    jellyComposite._lastAppliedFirmness = -1;

    // 2.5D飛び越えレーン用衝突カテゴリ（壁・天井のみ反射）へ切替 ＆ 半カプセル（0.5）維持で天井非激突を保証
    setSoftBodyCollisionCategory(jellyComposite, COLLISION_CATEGORY.BAR_HOPPING);
    startShapeMorph(jellyComposite, 0.5, FLOAT_BAR.MORPH_DURATION_MS || 160, now);

    const particles = jellyComposite.particles;
    if (!particles || particles.length === 0) return;

    const hopX = hopVelocity ? (hopVelocity.x || 0) : 0;
    const rawHopY = hopVelocity ? (hopVelocity.y || 0) : -5.80;
    // 値 64 以上の半カプセル半高が大きいゼリーの上向き初速を天井非激突上限へ自動制限
    const safeMaxUpSpeed = getSafeHopMaxUpSpeed(jellyComposite);
    const hopY = (rawHopY < -safeMaxUpSpeed) ? -safeMaxUpSpeed : rawHopY;
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
        tempVec.x = vx;
        tempVec.y = vy;
        Body.setVelocity(p, tempVec);
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

/**
 * 斜め下ショット限定すり抜け保護（barGraceActive）の AABB 完全離脱検知解除
 * 全 BAR_FLOATING ゼリーとの重なりが完全に消えた瞬間、または上限 220ms 経過で通常衝突マスクへ安全復帰する
 * @param {Matter.Composite} comp
 * @param {Array<Matter.Composite>} composites
 * @param {number} now
 */
export function updateBarGraceState(comp, composites, now) {
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
 * ホップ着地時の「進行方向前方優先 ＆ 壁際閉塞回避付き 異数字限定セーフ・リキャッチ（最大3パス連鎖押し分け）」
 * 進行方向の前方（飛び越えた先）へ優先着地し、重なる異数字カプセルおよび玉突きされた隣カプセルを
 * 最大 3 パス（収束時即終了）で安全に押し分ける（同数字は押し分けず即合体）
 */
function applySafeRecatchSeparation(comp, composites, hopDirX = 0) {
    if (!comp || !comp.centroid) return;

    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const padX = Math.max(frameW + 4, FLOAT_BAR.PADDING_X || 26);
    const compHalfW = comp.capsuleHalfWidth || comp.targetRadius || 24.0;
    const minCenterX = padX + compHalfW;
    const maxCenterX = GAME_WIDTH - padX - compHalfW;
    const initialForwardDir = (hopDirX > 0.05) ? 1 : ((hopDirX < -0.05) ? -1 : 0);

    recatchFloatingBuffer.length = 0;
    for (let i = 0; i < composites.length; i++) {
        const c = composites[i];
        if (c && c.label === 'jelly_composite' && c.isFloating && !c.isMerging && c.centroid) {
            recatchFloatingBuffer.push(c);
        }
    }

    const floatingCount = recatchFloatingBuffer.length;
    if (floatingCount < 2) {
        recatchFloatingBuffer.length = 0;
        return;
    }

    for (let pass = 0; pass < 3; pass++) {
        let movedInPass = false;
        const forwardDir = (pass === 0) ? initialForwardDir : 0;

        // 1. 着地したゼリー comp と異数字カプセルの押し分け（パス 0 は進行方向前方優先）
        for (let i = 0; i < floatingCount; i++) {
            const other = recatchFloatingBuffer[i];
            if (other === comp) continue;
            // 同数字は押し分けず、そのまま接触させて上段即合体を成立させる
            if (other.jellyValue === comp.jellyValue) continue;

            const otherHalfW = other.capsuleHalfWidth || other.targetRadius || 24.0;
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
                    movedInPass = true;
                    // 初パスのみ滑らかに割り込めるよう軽い横滑り速度を付与
                    if (pass === 0) {
                        const oPts = other.particles;
                        for (let k = 0; k < oPts.length; k++) {
                            tempVec.x = oPts[k].velocity.x + pushDir * 0.35;
                            tempVec.y = oPts[k].velocity.y;
                            Body.setVelocity(oPts[k], tempVec);
                        }
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
                        movedInPass = true;
                    }
                }
            }
        }

        // 2. 玉突き押し出しで重なった他ゼリー同士の異数字連鎖押し分け（バー上 3〜4 個密集時のめり込み根絶）
        for (let i = 0; i < floatingCount; i++) {
            const a = recatchFloatingBuffer[i];
            if (a === comp) continue;
            const halfWA = a.capsuleHalfWidth || a.targetRadius || 24.0;
            const minXA = padX + halfWA;
            const maxXA = GAME_WIDTH - padX - halfWA;

            for (let j = i + 1; j < floatingCount; j++) {
                const b = recatchFloatingBuffer[j];
                if (b === comp) continue;
                // 同数字同士は押し分けず即合体を維持
                if (a.jellyValue === b.jellyValue) continue;

                const halfWB = b.capsuleHalfWidth || b.targetRadius || 24.0;
                const requiredDist = halfWA + halfWB + 2;
                const dx = b.centroid.x - a.centroid.x;
                const absDx = Math.abs(dx);

                if (absDx < requiredDist) {
                    const sep = requiredDist - absDx;
                    const dir = (absDx < 0.5)
                        ? ((b.centroid.x >= GAME_WIDTH * 0.5) ? 1 : -1)
                        : (dx >= 0 ? 1 : -1);
                    const minXB = padX + halfWB;
                    const maxXB = GAME_WIDTH - padX - halfWB;

                    const roomB = dir > 0
                        ? Math.max(0, maxXB - b.centroid.x)
                        : Math.max(0, b.centroid.x - minXB);
                    const roomA = dir > 0
                        ? Math.max(0, a.centroid.x - minXA)
                        : Math.max(0, maxXA - a.centroid.x);

                    let shiftB = Math.min(sep * 0.5, roomB);
                    let shiftA = Math.min(sep - shiftB, roomA);
                    const remain = sep - shiftB - shiftA;
                    if (remain > 0.1 && roomB > shiftB) {
                        shiftB = Math.min(roomB, shiftB + remain);
                    }

                    if (shiftB > 0.1) {
                        shiftSoftBody(b, dir * shiftB, 0);
                        movedInPass = true;
                    }
                    if (shiftA > 0.1) {
                        shiftSoftBody(a, -dir * shiftA, 0);
                        movedInPass = true;
                    }
                }
            }
        }

        if (!movedInPass) break;
    }

    recatchFloatingBuffer.length = 0;
}

/**
 * ホップ着地時に下段フィールド内ゼリーが高く積み上がっている場合、重なり爆発を防ぐため安全高度へ着地位置を補正する
 */
function ensureSafeHopLandingAltitude(comp, composites) {
    if (!comp || !comp.centroid || !comp.aabb) return;

    const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;
    const compHalfH = comp.capsuleHalfHeight || comp.targetRadius || 24.0;
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
 * 天井非激突 2.5D 上段飛び越えホップの専用重力・半カプセル水平安定 ＆ セーフ・リキャッチ制御
 */
export function updateBarHopState(comp, geom, composites, now, gravityY, gravityScale) {
    if (!comp.isBarHopping) return;

    const particles = comp.particles;
    const n = particles.length;
    const { cx, cy, vx: avgVx, vy: avgVy } = geom;
    const hopGravityScale = (FLOAT_BAR.HOP_GRAVITY_SCALE !== undefined) ? FLOAT_BAR.HOP_GRAVITY_SCALE : 1.92;
    const hopMinAirMs = FLOAT_BAR.HOP_MIN_AIR_MS || 160;
    const hopRecatchYMin = FLOAT_BAR.HOP_RECATCH_Y_MIN || 102;
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
        comp.hasLanded = false;
        comp.landedAt = 0;
        comp.launchedAt = 0;
        comp.landedFirmness = 0.0;
        comp._lastAppliedFirmness = -1;

        // 下段高積み上げ時の重なり暴発を防ぐ安全着地高度チェックを適用
        ensureSafeHopLandingAltitude(comp, composites);

        // 上段待機カテゴリへ復帰（着地先の同数字と即座に合体・異数字と押し合い可能）
        setSoftBodyCollisionCategory(comp, COLLISION_CATEGORY.BAR_FLOATING);
        // 140msかけて半カプセルから横長カプセルへ滑らかに着席モーフィング
        startShapeMorph(comp, 1.0, FLOAT_BAR.RECATCH_MORPH_DURATION_MS || 140, now);

        // 着地時の縦勢いを吸収し、横の勢いを適度に残して隣ゼリーとの合体・着地を滑らかにする
        for (let j = 0; j < n; j++) {
            const body = particles[j];
            tempVec.x = body.velocity.x * 0.65;
            tempVec.y = body.velocity.y * 0.15;
            Body.setVelocity(body, tempVec);
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

        tempForce.x = forceX;
        tempForce.y = forceY;
        Body.applyForce(body, body.position, tempForce);
    }
}

/**
 * 上段フロートバー上の無重力フック・柔らかな上下レール圧縮・極弱姿勢ガイド・低減衰横スライド制御
 */
export function applyFloatBarControl(comp, cx, cy, gravityY, gravityScale, stepDampX, stepDampY) {
    if (!comp.isFloating) return;

    const particles = comp.particles;
    const n = particles.length;
    const targetY = FLOAT_BAR.Y;
    const centerX = GAME_WIDTH / 2;
    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const safePadX = Math.max(frameW + 4, FLOAT_BAR.PADDING_X || 26);
    const halfWidth = comp.capsuleHalfWidth || comp.targetRadius || 24.0;
    const barMinX = safePadX + halfWidth;
    const barMaxX = GAME_WIDTH - safePadX - halfWidth;
    const packForce = FLOAT_BAR.PACK_FORCE || 0.00005;
    const curScale = comp.currentGrowScale || 1.0;

    // 上下フラット帯（CHANNEL_HALF_HEIGHT）への圧縮フック設定
    const capRingHalfH = (comp.capsuleRingHalfHeight || Math.max(4, (FLOAT_BAR.CHANNEL_HALF_HEIGHT || 25) - (comp.particleRadius || 4))) * curScale;
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

        tempForce.x = forceX;
        tempForce.y = forceY;
        Body.applyForce(body, body.position, tempForce);

        // 横方向は極低ダンピング（スルスル滑る）、縦方向は液体らしいタプタプ揺れを残す減衰を適用
        tempVec.x = body.velocity.x * stepDampX;
        tempVec.y = body.velocity.y * stepDampY;
        Body.setVelocity(body, tempVec);
    }
}