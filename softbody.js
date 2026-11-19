/**
 * softbody.js
 * @version v3.0 (Overhaul Step 6)
 * @changes
 *   - 重い中心コア剛体を完全撤廃し、本家準拠の「中空ビーズリング（隣接皮バネ＋1つ飛ばし曲げ拘束）」構造へ刷新
 *   - 毎サブステップ実行を前提とした PBD（位置ベース）面積保存圧力およびアンチ裏返り自動修復を実装し、小さいゼリーのペシャンコ崩壊を根絶
 *   - 本家スコア仕様対応の hasMerged フラグ管理、重心（centroid）および循環平均による平均回転角（avgAngle）の毎ステップ更新を追加
 *   - 上部フロートバー上の横方向減衰を低減（FLOAT_BAR.X_DAMPING）してスルスル滑る挙動へ改善し、launchFloatingJelly() を本家v1.2準拠の「加算速度発射」へ変更
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスを /sobosuba/constants.js?v=3 へ統一
 * 
 * ソフトボディ（中空ビーズリング剛体）の生成・物理更新モジュール
 * 
 * 中心に剛体コアを持たず、外周の数珠つなぎビーズと表面張力・曲げ拘束・PBD面積保存圧力により、
 * 粘り気がなく水風船のように流動的に変形する本家sobosuba風の挙動を実現します。
 * ESM経由でMatter.jsを直接読み込み、起動エラーを防ぎます。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, PHYSICS, JELLY_CONFIG, FLOAT_BAR } from '/sobosuba/constants.js?v=3';

const Bodies = Matter.Bodies;
const Composite = Matter.Composite;
const Constraint = Matter.Constraint;
const Body = Matter.Body;

// ゼリーを一意に識別するためのカウンター（合体判定などで使用）
let jellyIdCounter = 0;

/**
 * 中空ビーズリング型ソフトボディゼリー（Sobo）を生成する
 * @param {number} x - 生成する中心X座標
 * @param {number} y - 生成する中心Y座標
 * @param {number} value - ゼリーの数値 (1, 2, 4, 8...)
 * @param {Object|null} initialVelocity - 生成時の初速ベクトル {x, y} (無い場合はnull)
 * @param {boolean} isFloating - 上部フロートバー上で無重力浮遊させるかどうか
 * @param {boolean} hasMerged - 既に合体に参加済み（スコア加算済み・太字表示）かどうか
 * @returns {Matter.Composite} 生成された中空ビーズリングの複合体
 */
export function createSoftBodyJelly(x, y, value, initialVelocity = null, isFloating = false, hasMerged = false) {
    const config = JELLY_CONFIG[value] || JELLY_CONFIG[16384] || JELLY_CONFIG[8192];
    const radius = config.radius;
    const particleCount = Math.max(12, config.particles || 12);
    const beadRatio = PHYSICS.BEAD_RADIUS_RATIO || 0.22;
    const particleRadius = Math.max(3.5, radius * beadRatio);
    const ringRadius = Math.max(4, radius - particleRadius);

    // ソフトボディ全体をまとめるコンポジット（複合体）
    const jellyComposite = Composite.create({ label: 'jelly_composite' });
    const currentJellyId = `jelly_${jellyIdCounter++}`;
    const createdAt = Date.now();

    // 同一ゼリー内のビーズ同士が反発して爆発するのを防ぐ負のコリジョングループ
    const group = Body.nextGroup(true);

    // ==========================================
    // 1. 外周ビーズ剛体（中空リング：中心コアなし）の生成
    // ==========================================
    const particles = [];

    for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2;
        // 中心から時計回り（Canvas座標系）にリング配置
        const px = x + Math.cos(angle) * ringRadius;
        const py = y + Math.sin(angle) * ringRadius;

        const particle = Bodies.circle(px, py, particleRadius, {
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
    const segmentLength = 2 * ringRadius * Math.sin(Math.PI / particleCount);
    for (let i = 0; i < particleCount; i++) {
        const p1 = particles[i];
        const p2 = particles[(i + 1) % particleCount];

        const skinConstraint = Constraint.create({
            bodyA: p1,
            bodyB: p2,
            length: segmentLength,
            stiffness: PHYSICS.SKIN_STIFFNESS,
            damping: PHYSICS.SOFTBODY_DAMPING,
            render: { visible: false }
        });
        Composite.add(jellyComposite, skinConstraint);
    }

    // ==========================================
    // 3. 1つ飛ばしビーズ間の弱い曲げ拘束（シワ折れ・鋭角崩壊防止）
    // ==========================================
    const bendLength = 2 * ringRadius * Math.sin((2 * Math.PI) / particleCount);
    for (let i = 0; i < particleCount; i++) {
        const p1 = particles[i];
        const p2 = particles[(i + 2) % particleCount];

        const bendConstraint = Constraint.create({
            bodyA: p1,
            bodyB: p2,
            length: bendLength,
            stiffness: PHYSICS.BEND_STIFFNESS,
            damping: PHYSICS.SOFTBODY_DAMPING,
            render: { visible: false }
        });
        Composite.add(jellyComposite, bendConstraint);
    }

    // コンポジット自体に高速参照用・物理更新用のメタデータを保持
    jellyComposite.jellyId = currentJellyId;
    jellyComposite.jellyValue = value;
    jellyComposite.isMerging = false;
    jellyComposite.isFloating = Boolean(isFloating);
    jellyComposite.hasMerged = Boolean(hasMerged);
    jellyComposite.createdAt = createdAt;
    jellyComposite.particles = particles;
    jellyComposite.targetRadius = radius;
    jellyComposite.ringRadius = ringRadius;
    jellyComposite.particleRadius = particleRadius;
    jellyComposite.centroid = { x, y };
    jellyComposite.avgAngle = 0;
    // 外周ビーズ中心が囲む正多角形の目標面積
    jellyComposite.targetArea = 0.5 * particleCount * ringRadius * ringRadius * Math.sin((2 * Math.PI) / particleCount);

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
 * フロートバー上のゼリーを無重力状態から解除し、現在の移動速度に加算（Additive Momentum）して発射する
 * @param {Matter.Composite} jellyComposite - 発射するゼリーのコンポジット
 * @param {Object} addVelocity - 加算する発射速度ベクトル {x, y}（そっと落とし時は {x: 0, y: 0}）
 */
export function launchFloatingJelly(jellyComposite, addVelocity = { x: 0, y: 0 }) {
    if (!jellyComposite) return;
    jellyComposite.isFloating = false;

    const particles = jellyComposite.particles;
    if (!particles || particles.length === 0) return;

    const addX = addVelocity ? (addVelocity.x || 0) : 0;
    const addY = addVelocity ? (addVelocity.y || 0) : 0;
    const maxSpeed = PHYSICS.MAX_PARTICLE_SPEED || 15;
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
 * 毎サブステップ呼び出されるソフトボディ物理更新関数
 * 1. 靴紐の公式による重心・符号付き面積・周長・平均回転角の算出
 * 2. アンチ裏返り自動修復（面積が極端に縮小・負転した際の即時形状復元）
 * 3. PBD（位置ベース）面積保存補正 ＋ 補助内部圧力 ＋ 最小距離復元
 * 4. 上部フロートバー上での無重力弾性フック＆低減衰横スライド制御
 * 5. 全ビーズの最大速度クランプ（すり抜け・物理爆発防止）
 * @param {Matter.World} world - Matter.jsの物理世界
 * @param {Matter.Engine} engine - Matter.jsのエンジン
 */
export function updateSoftBodies(world, engine) {
    if (!world || !engine) return;

    const composites = Composite.allComposites(world);
    const gravityY = engine.gravity.y;
    const gravityScale = engine.gravity.scale;
    const substeps = Math.max(1, PHYSICS.SUBSTEPS || 4);
    const maxSpeed = PHYSICS.MAX_PARTICLE_SPEED || 15;
    const maxSpeedSq = maxSpeed * maxSpeed;
    const pbdStiffnessPerStep = (PHYSICS.PBD_AREA_STIFFNESS || 0.65) / substeps;
    const maxCorr = PHYSICS.PBD_MAX_CORRECTION || 2.5;
    const inversionRatio = PHYSICS.INVERSION_AREA_RATIO || 0.25;
    const minDistRatio = PHYSICS.SOFTBODY_MIN_DIST_RATIO || 0.45;
    const packForce = FLOAT_BAR.PACK_FORCE || 0.00006;

    // 1フレームあたりの減衰率をサブステップ回数に応じて等価変換
    const stepDampX = Math.pow(FLOAT_BAR.X_DAMPING || 0.985, 1 / substeps);
    const stepDampY = Math.pow(FLOAT_BAR.Y_DAMPING || 0.88, 1 / substeps);

    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp.label !== 'jelly_composite') continue;

        const particles = comp.particles;
        if (!particles || particles.length < 3) continue;

        const n = particles.length;
        const ringRadius = comp.ringRadius || 14;
        const pRadius = comp.particleRadius || 4;
        const targetArea = comp.targetArea || (Math.PI * ringRadius * ringRadius);

        // ==========================================
        // 1. 重心・符号付き面積（靴紐の公式）・周長を算出
        // ==========================================
        let cx = 0;
        let cy = 0;
        let signedArea = 0;
        let perimeter = 0;

        for (let j = 0; j < n; j++) {
            const p1 = particles[j].position;
            const p2 = particles[(j + 1) % n].position;
            cx += p1.x;
            cy += p1.y;
            // Canvas座標系（Y軸下向き）で時計回り配置のため、正常時は正の面積になる
            signedArea += (p1.x * p2.y - p2.x * p1.y);
            const ex = p2.x - p1.x;
            const ey = p2.y - p1.y;
            perimeter += Math.sqrt(ex * ex + ey * ey);
        }
        cx /= n;
        cy /= n;
        signedArea *= 0.5;

        // 重心をインプレース更新
        if (!comp.centroid) {
            comp.centroid = { x: cx, y: cy };
        } else {
            comp.centroid.x = cx;
            comp.centroid.y = cy;
        }

        // ==========================================
        // 2. アンチ裏返り自動修復（ペシャンコ・8の字崩壊の即時復元）
        // ==========================================
        if (signedArea < targetArea * inversionRatio) {
            const baseAngle = comp.avgAngle || 0;
            const safeRadius = ringRadius * 0.88;
            // 重心自体が壁・床にめり込まないよう安全範囲に収める
            const safeCx = Math.max(pRadius + safeRadius, Math.min(GAME_WIDTH - pRadius - safeRadius, cx));
            const safeCy = Math.max(pRadius + safeRadius, Math.min(GAME_HEIGHT - pRadius - safeRadius, cy));

            for (let j = 0; j < n; j++) {
                const pCurr = particles[j];
                const idealAngle = baseAngle + (pCurr.initialAngle !== undefined ? pCurr.initialAngle : ((j / n) * Math.PI * 2));
                const targetX = safeCx + Math.cos(idealAngle) * safeRadius;
                const targetY = safeCy + Math.sin(idealAngle) * safeRadius;

                // 現在位置から理想リング座標へ即座に55%引き戻して裏返りを解除
                const nextX = pCurr.position.x + (targetX - pCurr.position.x) * 0.55;
                const nextY = pCurr.position.y + (targetY - pCurr.position.y) * 0.55;

                Body.setPosition(pCurr, {
                    x: Math.max(pRadius, Math.min(GAME_WIDTH - pRadius, nextX)),
                    y: Math.max(pRadius, Math.min(GAME_HEIGHT - pRadius, nextY))
                });
                // 崩壊時の暴走速度を抑えて安定着地させる
                Body.setVelocity(pCurr, {
                    x: pCurr.velocity.x * 0.5,
                    y: pCurr.velocity.y * 0.5
                });
            }
            continue;
        }

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

        // ==========================================
        // 3. PBD（位置ベース）面積保存補正 ＆ 補助内部圧力
        // ==========================================
        const areaDiff = targetArea - signedArea;
        const safePerimeter = Math.max(perimeter, 1);
        // 不足面積を外周全体へ均等に割り振るPBD法線変位量（膨張優先・過膨張は穏やかに収縮）
        let pbdDelta = (areaDiff / safePerimeter) * pbdStiffnessPerStep;
        if (pbdDelta > maxCorr) pbdDelta = maxCorr;
        else if (pbdDelta < -maxCorr * 0.35) pbdDelta = -maxCorr * 0.35;

        // 補助的な力ベース内部圧力（ボヨンとした弾性揺れを維持）
        const areaRatio = Math.max(-0.8, Math.min(2.0, areaDiff / targetArea));
        const pressureStrength = areaRatio * (PHYSICS.SOFTBODY_PRESSURE || 0.00055) * 4.0;
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

            // (A) PBD位置ベース面積保存（壁・床を突き抜けない範囲で直接押し戻す）
            if (Math.abs(pbdDelta) > 0.0005) {
                const corrX = Math.max(pRadius, Math.min(GAME_WIDTH - pRadius, pCurr.position.x + nx * pbdDelta));
                const corrY = Math.max(pRadius, Math.min(GAME_HEIGHT - pRadius, pCurr.position.y + ny * pbdDelta));
                Body.setPosition(pCurr, { x: corrX, y: corrY });
            }

            // (B) 補助的な力ベース内圧
            const forceMag = pressureStrength * pCurr.mass;
            Body.applyForce(pCurr, pCurr.position, {
                x: nx * forceMag,
                y: ny * forceMag
            });

            // (C) 最小距離復元（重心への過度なめり込みを防止）
            if (dist < minDist) {
                const overlap = minDist - dist;
                const restoreMag = overlap * 0.0004 * pCurr.mass;
                Body.applyForce(pCurr, pCurr.position, {
                    x: radialX * restoreMag,
                    y: radialY * restoreMag
                });
            }
        }

        // ==========================================
        // 4. 上部フロートバー上での無重力弾性フック ＆ 低減衰横スライド制御
        // ==========================================
        if (comp.isFloating) {
            const targetY = FLOAT_BAR.Y;
            const centerX = GAME_WIDTH / 2;
            const minX = FLOAT_BAR.PADDING_X + comp.targetRadius;
            const maxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - comp.targetRadius;

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
                if (cx < minX) {
                    holdForceX += (minX - cx) * FLOAT_BAR.SPRING_STIFFNESS * 0.0006 * body.mass;
                } else if (cx > maxX) {
                    holdForceX += (maxX - cx) * FLOAT_BAR.SPRING_STIFFNESS * 0.0006 * body.mass;
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
        // 5. すり抜け・物理爆発防止の最大速度クランプ
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
    }
}