/**
 * softbody.js
 * @version v2.0 (Bugfix Step 4)
 * @changes
 *   - 上部フロートバー上でゼリー同士を中央へ寄せて接触・合体を促す横方向引力（FLOAT_BAR.PACK_FORCE）を追加
 *   - 面積の負転・極小化や接線法線の反転時に、重心から外側への放射状ベクトルへ切り替える裏返り崩壊フェイルセーフを実装
 *   - すり抜け・物理爆発を防ぐため、コアおよび全パーティクルの速度を PHYSICS.MAX_PARTICLE_SPEED 以下へ制限するクランプを追加
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスに ?v=2 を付与
 * 
 * ソフトボディ（ぐにゃぐにゃ剛体）の生成・物理更新モジュール
 * 
 * 水風船のような内部圧力（面積保存による膨張力）と裏返り防止ロジック、
 * および上部フロートバーでの無重力浮遊ロジックを実装します。
 * ESM経由でMatter.jsを直接読み込み、起動エラーを防ぎます。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, PHYSICS, JELLY_CONFIG, FLOAT_BAR } from '/sobosuba/constants.js?v=2';

const Bodies = Matter.Bodies;
const Composite = Matter.Composite;
const Constraint = Matter.Constraint;
const Body = Matter.Body;

// ゼリーを一意に識別するためのカウンター（合体判定などで使用）
let jellyIdCounter = 0;

/**
 * ぐにゃぐにゃ変形するソフトボディゼリーを生成する
 * @param {number} x - 投下・生成するX座標
 * @param {number} y - 投下・生成するY座標
 * @param {number} value - ゼリーの数値 (1, 2, 4, 8...)
 * @param {Object} initialVelocity - 発射時の初速ベクトル {x, y} (無い場合はnull)
 * @param {boolean} isFloating - 上部フロートバー上で無重力浮遊させるかどうか
 * @returns {Matter.Composite} 生成されたソフトボディの複合体
 */
export function createSoftBodyJelly(x, y, value, initialVelocity = null, isFloating = false) {
    const config = JELLY_CONFIG[value] || JELLY_CONFIG[8192];
    const radius = config.radius;
    const particleCount = config.particles || 12; // 外殻を構成するパーティクルの数
    const particleRadius = radius * 0.25; // 外殻の小円サイズ
    const ringRadius = Math.max(4, radius - particleRadius);
    
    // ソフトボディ全体をまとめるコンポジット（複合体）
    const jellyComposite = Composite.create({ label: 'jelly_composite' });
    const currentJellyId = `jelly_${jellyIdCounter++}`;

    // パーティクル同士が内側で反発して爆発するのを防ぐためのコリジョングループ
    // 同じグループ番号(負の値)を持つ剛体同士は衝突しなくなります
    const group = Body.nextGroup(true);

    // ==========================================
    // 1. 中心のコア剛体を生成
    // ==========================================
    const coreRadius = radius * 0.3;
    const core = Bodies.circle(x, y, coreRadius, {
        density: PHYSICS.DENSITY_CORE,
        friction: PHYSICS.FRICTION,
        restitution: PHYSICS.RESTITUTION,
        label: 'jelly_core',
        collisionFilter: { group: group }
    });
    
    // 衝突判定や描画時に使用するメタデータを付与
    core.jellyValue = value;
    core.jellyId = currentJellyId;
    core.isMerging = false;
    core.parentComposite = jellyComposite;
    core.createdAt = Date.now();

    Composite.add(jellyComposite, core);

    // ==========================================
    // 2. 外殻パーティクル剛体と、コアを繋ぐ柔軟なバネの生成
    // ==========================================
    const particles = [];
    
    for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2;
        // コアを中心とした円周上に時計回り（Canvas座標系）で配置
        const px = x + Math.cos(angle) * ringRadius;
        const py = y + Math.sin(angle) * ringRadius;
        
        const particle = Bodies.circle(px, py, particleRadius, {
            density: PHYSICS.DENSITY_PARTICLE,
            friction: PHYSICS.FRICTION,
            restitution: PHYSICS.RESTITUTION,
            label: 'jelly_particle',
            collisionFilter: { group: group }
        });

        // 外殻パーティクルにもメタデータを付与
        particle.jellyValue = value;
        particle.jellyId = currentJellyId;
        particle.isMerging = false;
        particle.parentComposite = jellyComposite;
        particle.particleRadius = particleRadius;

        particles.push(particle);
        Composite.add(jellyComposite, particle);
        
        // コアと外殻パーティクルを繋ぐバネ（流動性を出すため柔軟に設定）
        const coreConstraint = Constraint.create({
            bodyA: core,
            bodyB: particle,
            length: ringRadius,
            stiffness: PHYSICS.SOFTBODY_STIFFNESS,
            damping: PHYSICS.SOFTBODY_DAMPING,
            render: { visible: false }
        });
        Composite.add(jellyComposite, coreConstraint);
    }

    // ==========================================
    // 3. 外殻パーティクル同士を繋ぐ表面張力バネ（輪郭）の生成
    // ==========================================
    const segmentLength = 2 * ringRadius * Math.sin(Math.PI / particleCount);
    for (let i = 0; i < particleCount; i++) {
        const p1 = particles[i];
        const p2 = particles[(i + 1) % particleCount];
        
        const perimeterConstraint = Constraint.create({
            bodyA: p1,
            bodyB: p2,
            length: segmentLength,
            stiffness: PHYSICS.SOFTBODY_PERIMETER_STIFFNESS,
            damping: PHYSICS.SOFTBODY_DAMPING,
            render: { visible: false }
        });
        Composite.add(jellyComposite, perimeterConstraint);
    }

    // コンポジット自体に高速参照用・物理更新用のメタデータを保持
    jellyComposite.jellyId = currentJellyId;
    jellyComposite.jellyValue = value;
    jellyComposite.isMerging = false;
    jellyComposite.isFloating = isFloating;
    jellyComposite.core = core;
    jellyComposite.particles = particles;
    jellyComposite.targetRadius = radius;
    jellyComposite.ringRadius = ringRadius;
    jellyComposite.particleRadius = particleRadius;
    // 外周パーティクル中心が囲む正多角形の目標面積
    jellyComposite.targetArea = 0.5 * particleCount * ringRadius * ringRadius * Math.sin((2 * Math.PI) / particleCount);

    // ==========================================
    // 4. 発射時の初速付与
    // ==========================================
    if (initialVelocity) {
        Body.setVelocity(core, initialVelocity);
        for (let i = 0; i < particles.length; i++) {
            Body.setVelocity(particles[i], initialVelocity);
        }
    }

    return jellyComposite;
}

/**
 * フロートバー上のゼリーを無重力状態から解除し、指定した初速で発射する
 * @param {Matter.Composite} jellyComposite - 発射するゼリーのコンポジット
 * @param {Object} velocity - 発射初速ベクトル {x, y}
 */
export function launchFloatingJelly(jellyComposite, velocity) {
    if (!jellyComposite) return;
    jellyComposite.isFloating = false;

    if (jellyComposite.core) {
        Body.setVelocity(jellyComposite.core, velocity);
    }
    if (jellyComposite.particles) {
        for (let i = 0; i < jellyComposite.particles.length; i++) {
            Body.setVelocity(jellyComposite.particles[i], velocity);
        }
    }
}

/**
 * 毎フレーム呼び出されるソフトボディ物理更新関数
 * 1. 靴紐の公式による面積保存（内部圧力・気体膨張力）と裏返りフェイルセーフ
 * 2. 中心めり込みによる裏返り（三日月化）防止
 * 3. 上部フロートバー上での無重力浮遊＆中央横寄せ引力制御
 * 4. 全パーツの最大速度クランプ（すり抜け・物理爆発防止）
 * @param {Matter.World} world - Matter.jsの物理世界
 * @param {Matter.Engine} engine - Matter.jsのエンジン
 */
export function updateSoftBodies(world, engine) {
    if (!world || !engine) return;

    const composites = Composite.allComposites(world);
    const gravityY = engine.gravity.y;
    const gravityScale = engine.gravity.scale;
    const maxSpeed = PHYSICS.MAX_PARTICLE_SPEED || 14;
    const packForce = FLOAT_BAR.PACK_FORCE || 0.00012;

    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp.label !== 'jelly_composite') continue;

        const core = comp.core;
        const particles = comp.particles;
        if (!core || !particles || particles.length < 3) continue;

        const n = particles.length;
        const ringRadius = comp.ringRadius || 16;
        const targetArea = comp.targetArea || (Math.PI * ringRadius * ringRadius);

        // ==========================================
        // 1. 外周パーティクルの重心と現在の面積（靴紐の公式）を算出
        // ==========================================
        let cx = 0;
        let cy = 0;
        let signedArea = 0;

        for (let j = 0; j < n; j++) {
            const p1 = particles[j].position;
            const p2 = particles[(j + 1) % n].position;
            cx += p1.x;
            cy += p1.y;
            // Canvas座標系（Y軸下向き）で時計回り配置のため、正常時は正の面積になる
            signedArea += (p1.x * p2.y - p2.x * p1.y);
        }
        cx /= n;
        cy /= n;
        signedArea *= 0.5;

        // 面積が負または極小（裏返り・交差の兆候）かどうかを判定
        const isInvertedOrCollapsed = signedArea < targetArea * 0.25;

        // ==========================================
        // 2. 内部圧力（気体膨張力）と裏返りフェイルセーフの適用
        // ==========================================
        // 目標面積との差分から内圧を算出（暴走しないようクランプ）
        const areaRatio = (targetArea - signedArea) / targetArea;
        const clampedRatio = Math.max(-1.0, Math.min(2.5, areaRatio));
        const pressureStrength = clampedRatio * PHYSICS.SOFTBODY_PRESSURE * 6.0;

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
                const fallbackAngle = (j / n) * Math.PI * 2;
                radialX = Math.cos(fallbackAngle);
                radialY = Math.sin(fallbackAngle);
            }

            // 隣接パーティクル間の接線ベクトルから外向き法線を求める
            const tx = pNext.x - pPrev.x;
            const ty = pNext.y - pPrev.y;
            const tLen = Math.sqrt(tx * tx + ty * ty);

            let nx = radialX;
            let ny = radialY;

            // 裏返り・交差の兆候がない場合のみ接線法線を採用し、内向き反転時は放射状ベクトルへ切り替え
            if (!isInvertedOrCollapsed && tLen > 0.0001) {
                // 時計回り（Y下向き）の外向き法線は (ty, -tx)
                const candNx = ty / tLen;
                const candNy = -tx / tLen;
                // 重心から見て外向き（内積が正）か検証
                if ((candNx * radialX + candNy * radialY) > 0) {
                    nx = candNx;
                    ny = candNy;
                }
            }

            const forceMag = pressureStrength * pCurr.mass;
            Body.applyForce(pCurr, pCurr.position, {
                x: nx * forceMag,
                y: ny * forceMag
            });

            // ==========================================
            // 3. 裏返り（三日月化）防止の最小距離復元力
            // ==========================================
            const minDist = ringRadius * PHYSICS.SOFTBODY_MIN_DIST_RATIO;

            if (dist < minDist) {
                const overlap = minDist - dist;
                const restoreMag = overlap * 0.00035 * pCurr.mass;
                Body.applyForce(pCurr, pCurr.position, {
                    x: radialX * restoreMag,
                    y: radialY * restoreMag
                });
            }
        }

        // コア剛体が外周の重心から大きく外れないよう穏やかに中央へ戻す
        const coreDx = cx - core.position.x;
        const coreDy = cy - core.position.y;
        Body.applyForce(core, core.position, {
            x: coreDx * 0.00015 * core.mass,
            y: coreDy * 0.00015 * core.mass
        });

        // ==========================================
        // 4. 上部フロートバー上での無重力浮遊＆中央横寄せ引力ロジック
        // ==========================================
        if (comp.isFloating) {
            const targetY = FLOAT_BAR.Y;
            const centerX = GAME_WIDTH / 2;
            const minX = FLOAT_BAR.PADDING_X + comp.targetRadius;
            const maxX = GAME_WIDTH - FLOAT_BAR.PADDING_X - comp.targetRadius;

            // 中央方向への正規化横寄せ係数（隣り合う同数字同士が自然に触れ合って合体するように促す）
            const dxCenter = centerX - cx;
            const packRatio = Math.max(-1, Math.min(1, dxCenter / 30));

            // コアと全パーティクルに対して重力を打ち消し、バーY座標および中央方向へ保持する
            const allParts = [core, ...particles];
            for (let j = 0; j < allParts.length; j++) {
                const body = allParts[j];

                // 重力打ち消し（無重力化）
                const antiGravityY = -gravityY * gravityScale * body.mass;

                // バーのY座標（FLOAT_BAR.Y）に留める復元力（重心基準）
                const dyBar = targetY - cy;
                const holdForceY = dyBar * FLOAT_BAR.SPRING_STIFFNESS * 0.0004 * body.mass;

                // 左右の余白内に収める復元力 ＋ バー中央方向へ寄せる横引力
                let holdForceX = packRatio * packForce * 1.5 * body.mass;
                if (cx < minX) {
                    holdForceX += (minX - cx) * FLOAT_BAR.SPRING_STIFFNESS * 0.0005 * body.mass;
                } else if (cx > maxX) {
                    holdForceX += (maxX - cx) * FLOAT_BAR.SPRING_STIFFNESS * 0.0005 * body.mass;
                }

                Body.applyForce(body, body.position, {
                    x: holdForceX,
                    y: antiGravityY + holdForceY
                });

                // 浮遊中の揺れを抑える穏やかな速度ダンピング
                Body.setVelocity(body, {
                    x: body.velocity.x * 0.92,
                    y: body.velocity.y * 0.88
                });
            }
        }

        // ==========================================
        // 5. すり抜け・物理爆発防止の最大速度クランプ
        // ==========================================
        const clampVelocity = (body) => {
            const vx = body.velocity.x;
            const vy = body.velocity.y;
            const speedSq = vx * vx + vy * vy;
            if (speedSq > maxSpeed * maxSpeed) {
                const scale = maxSpeed / Math.sqrt(speedSq);
                Body.setVelocity(body, {
                    x: vx * scale,
                    y: vy * scale
                });
            }
        };

        clampVelocity(core);
        for (let j = 0; j < n; j++) {
            clampVelocity(particles[j]);
        }
    }
}