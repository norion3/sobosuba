/**
 * softbody.js
 * ソフトボディ（ぐにゃぐにゃ剛体）の生成専用モジュール
 * 
 * 中心のコア剛体と、周囲を取り囲む複数の小パーティクル剛体を
 * バネ(Constraint)で繋ぎ合わせた複合体(Composite)を生成します。
 * ESM経由でMatter.jsを直接読み込み、起動エラーを防ぎます。
 */

import Matter from 'https://esm.sh/matter-js';
import { PHYSICS, JELLY_CONFIG } from '/sobosuba/constants.js';

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
 * @param {boolean} isDropping - プレイヤーが上から落とした直後かどうか（初速を与えるため）
 * @returns {Matter.Composite} 生成されたソフトボディの複合体
 */
export function createSoftBodyJelly(x, y, value, isDropping = false) {
    const config = JELLY_CONFIG[value] || JELLY_CONFIG[8192];
    const radius = config.radius;
    const particleCount = config.particles || 12; // 外殻を構成するパーティクルの数
    
    // ソフトボディ全体をまとめるコンポジット（複合体）
    const jellyComposite = Composite.create({ label: 'jelly_composite' });
    const currentJellyId = `jelly_${jellyIdCounter++}`;

    // パーティクル同士が内側で反発して爆発するのを防ぐためのコリジョングループ
    // 同じグループ番号(負の値)を持つ剛体同士は衝突しなくなります
    const group = Body.nextGroup(true);

    // ==========================================
    // 1. 中心のコア剛体を生成
    // ==========================================
    const coreRadius = radius * 0.35; // コアは実際の半径より少し小さめ
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
    core.isMerging = false; // 合体中の多重発火防止フラグ
    core.parentComposite = jellyComposite; // 自身が属するコンポジットへの参照

    Composite.add(jellyComposite, core);

    // ==========================================
    // 2. 外殻パーティクル剛体と、コアを繋ぐバネの生成
    // ==========================================
    const particles = [];
    const particleRadius = radius * 0.25; // 外殻の小円サイズ
    
    for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2;
        // コアを中心とした円周上に配置
        const px = x + Math.cos(angle) * (radius - particleRadius);
        const py = y + Math.sin(angle) * (radius - particleRadius);
        
        const particle = Bodies.circle(px, py, particleRadius, {
            density: PHYSICS.DENSITY_PARTICLE,
            friction: PHYSICS.FRICTION,
            restitution: PHYSICS.RESTITUTION,
            label: 'jelly_particle',
            collisionFilter: { group: group }
        });

        // 外殻パーティクルにもメタデータを付与（どこがぶつかっても合体判定できるようにするため）
        particle.jellyValue = value;
        particle.jellyId = currentJellyId;
        particle.isMerging = false;
        particle.parentComposite = jellyComposite;

        particles.push(particle);
        Composite.add(jellyComposite, particle);
        
        // コアと外殻パーティクルを繋ぐバネ（スポーク）
        const coreConstraint = Constraint.create({
            bodyA: core,
            bodyB: particle,
            stiffness: PHYSICS.SOFTBODY_STIFFNESS,
            damping: PHYSICS.SOFTBODY_DAMPING,
            render: { visible: false } // バネ自体は描画しない
        });
        Composite.add(jellyComposite, coreConstraint);
    }

    // ==========================================
    // 3. 外殻パーティクル同士を繋ぐバネ（輪郭）の生成
    // ==========================================
    for (let i = 0; i < particleCount; i++) {
        const p1 = particles[i];
        // 最後のパーティクルは最初のパーティクルと繋いで輪っかにする
        const p2 = particles[(i + 1) % particleCount];
        
        const perimeterConstraint = Constraint.create({
            bodyA: p1,
            bodyB: p2,
            stiffness: PHYSICS.SOFTBODY_STIFFNESS * 1.5, // 外郭は少し硬めにして形を保つ
            damping: PHYSICS.SOFTBODY_DAMPING,
            render: { visible: false }
        });
        Composite.add(jellyComposite, perimeterConstraint);
    }

    // ==========================================
    // 4. 落下時の初速付与
    // ==========================================
    if (isDropping) {
        const initialVelocity = { x: 0, y: 3 };
        Body.setVelocity(core, initialVelocity);
        for (let i = 0; i < particles.length; i++) {
            Body.setVelocity(particles[i], initialVelocity);
        }
    }

    return jellyComposite;
}